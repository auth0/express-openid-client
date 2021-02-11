const { promisify } = require('util');
const assert = require('chai').assert;
const crypto = require('crypto');
const request = require('request-promise-native').defaults({
  simple: false,
  resolveWithFullResponse: true,
});
const sinon = require('sinon');

const appSession = require('../lib/appSession');
const { encrypted } = require('./fixture/sessionEncryption');
const { makeIdToken } = require('./fixture/cert');
const { get: getConfig } = require('../lib/config');
const { create: createServer } = require('./fixture/server');
const redis = require('redis-mock');
const RedisStore = require('connect-redis')({ Store: class Store {} });

const defaultConfig = {
  clientID: '__test_client_id__',
  clientSecret: '__test_client_secret__',
  issuerBaseURL: 'https://op.example.com',
  baseURL: 'http://example.org',
  secret: '__test_secret__',
  errorOnRequiredAuth: true,
};

const login = async (claims) => {
  const jar = request.jar();
  await request.post('/session', {
    baseUrl,
    jar,
    json: {
      id_token: makeIdToken(claims),
    },
  });
  return jar;
};

const baseUrl = 'http://localhost:3000';

const HR_MS = 60 * 60 * 1000;

describe('appSession', () => {
  let server;
  let redisClient;
  let set;
  let store;

  const setup = (config) => {
    redisClient = redis.createClient();
    const store = new RedisStore({ client: redisClient, prefix: '' });
    // redisClient.getAsync = promisify(store.client.get).bind(store.client);
    set = promisify(store.set).bind(store);
    const conf = getConfig({
      ...defaultConfig,
      sessionStore: store,
      ...config,
    });
    return [createServer(appSession(conf)), store];
  };

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (redisClient) {
      await new Promise((resolve) => redisClient.quit(resolve));
    }
  });

  it('should not create a session when there are no cookies', async () => {
    server = await setup();
    const res = await request.get('/session', { baseUrl, json: true });
    assert.isEmpty(res.body);
  });

  it('should not error for non existent sessions', async () => {
    server = await setup();
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      headers: {
        cookie: 'appSession=__invalid_identity__',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.isEmpty(res.body);
  });

  it('should get an existing session', async () => {
    [server, store] = await setup();
    await new Promise((resolve) =>
      store.set('foo', JSON.stringify({ data: { sub: '__test_sub__' } }), () =>
        resolve()
      )
    );
    await new Promise((resolve) =>
      store.get('foo', (err, x) => {
        console.log('got in test', x);
        resolve();
      })
    );
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      headers: {
        cookie: `appSession=foo`,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sub, '__test_sub__');
  });

  it('should chunk and accept chunked cookies over 4kb', async () => {
    server = await createServer(appSession(getConfig(defaultConfig)));
    const jar = request.jar();
    const random = crypto.randomBytes(4000).toString('base64');
    await request.post('/session', {
      baseUrl,
      jar,
      json: {
        sub: '__test_sub__',
        random,
      },
    });
    assert.deepEqual(
      jar.getCookies(baseUrl).map(({ key }) => key),
      ['appSession.0', 'appSession.1']
    );
    const res = await request.get('/session', { baseUrl, json: true, jar });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      sub: '__test_sub__',
      random,
    });
  });

  it('should handle unordered chunked cookies', async () => {
    server = await createServer(appSession(getConfig(defaultConfig)));
    const jar = request.jar();
    const random = crypto.randomBytes(4000).toString('base64');
    await request.post('/session', {
      baseUrl,
      jar,
      json: {
        sub: '__test_sub__',
        random,
      },
    });
    const newJar = request.jar();
    jar
      .getCookies(baseUrl)
      .reverse()
      .forEach(({ key, value }) =>
        newJar.setCookie(`${key}=${value}`, baseUrl)
      );
    assert.deepEqual(
      newJar.getCookies(baseUrl).map(({ key }) => key),
      ['appSession.1', 'appSession.0']
    );
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      jar: newJar,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      sub: '__test_sub__',
      random,
    });
  });

  it('should not throw for malformed cookie chunks', async () => {
    server = await createServer(appSession(getConfig(defaultConfig)));
    const jar = request.jar();
    jar.setCookie('appSession.0=foo', baseUrl);
    jar.setCookie('appSession.1=bar', baseUrl);
    const res = await request.get('/session', { baseUrl, json: true, jar });
    assert.equal(res.statusCode, 200);
  });

  it('should set the default cookie options over http', async () => {
    server = await createServer(
      appSession(getConfig({ ...defaultConfig, baseURL: 'http://example.org' }))
    );
    const jar = request.jar();
    await request.get('/session', {
      baseUrl,
      json: true,
      jar,
      headers: {
        cookie: `appSession=${encrypted}`,
      },
    });
    const [cookie] = jar.getCookies(baseUrl);
    assert.deepInclude(cookie, {
      key: 'appSession',
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      extensions: ['SameSite=Lax'],
    });
    const expDate = new Date(cookie.expires);
    const now = Date.now();
    assert.approximately(Math.floor((expDate - now) / 1000), 86400, 5);
  });

  it('should set the default cookie options over https', async () => {
    server = await createServer(
      appSession(
        getConfig({ ...defaultConfig, baseURL: 'https://example.org' })
      )
    );
    const jar = request.jar();
    await request.get('/session', {
      baseUrl,
      json: true,
      jar,
      headers: {
        cookie: `appSession=${encrypted}`,
      },
    });
    // Secure cookies not set over http
    assert.isEmpty(jar.getCookies(baseUrl));
  });

  it('should set the custom cookie options', async () => {
    server = await createServer(
      appSession(
        getConfig({
          ...defaultConfig,
          session: {
            cookie: {
              httpOnly: false,
              sameSite: 'Strict',
            },
          },
        })
      )
    );
    const jar = request.jar();
    await request.get('/session', {
      baseUrl,
      json: true,
      jar,
      headers: {
        cookie: `appSession=${encrypted}`,
      },
    });
    const [cookie] = jar.getCookies(baseUrl);
    assert.deepInclude(cookie, {
      key: 'appSession',
      httpOnly: false,
      extensions: ['SameSite=Strict'],
    });
  });

  it('should use a custom cookie name', async () => {
    server = await createServer(
      appSession(
        getConfig({
          ...defaultConfig,
          session: { name: 'customName' },
        })
      )
    );
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      jar,
      headers: {
        cookie: `customName=${encrypted}`,
      },
    });
    const [cookie] = jar.getCookies(baseUrl);
    assert.equal(res.statusCode, 200);
    assert.equal(cookie.key, 'customName');
  });

  it('should set an ephemeral cookie', async () => {
    server = await createServer(
      appSession(
        getConfig({
          ...defaultConfig,
          session: { cookie: { transient: true } },
        })
      )
    );
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      jar,
      headers: {
        cookie: `appSession=${encrypted}`,
      },
    });
    const [cookie] = jar.getCookies(baseUrl);
    assert.equal(res.statusCode, 200);
    assert.isFalse(cookie.hasOwnProperty('expires'));
  });

  it('should not throw for expired cookies', async () => {
    const twoWeeks = 2 * 7 * 24 * 60 * 60 * 1000;
    const clock = sinon.useFakeTimers({
      now: Date.now(),
      toFake: ['Date'],
    });
    server = await createServer(appSession(getConfig(defaultConfig)));
    const jar = request.jar();
    clock.tick(twoWeeks);
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      jar,
      headers: {
        cookie: `appSession=${encrypted}`,
      },
    });
    assert.equal(res.statusCode, 200);
    clock.restore();
  });

  it('should throw for duplicate mw', async () => {
    server = await createServer((req, res, next) => {
      req.appSession = {};
      appSession(getConfig(defaultConfig))(req, res, next);
    });
    const res = await request.get('/session', { baseUrl, json: true });
    assert.equal(res.statusCode, 500);
    assert.equal(
      res.body.err.message,
      'req[appSession] is already set, did you run this middleware twice?'
    );
  });

  it('should throw for reassigning session', async () => {
    server = await createServer((req, res, next) => {
      appSession(getConfig(defaultConfig))(req, res, () => {
        try {
          req.appSession = {};
          next();
        } catch (e) {
          next(e);
        }
      });
    });
    const res = await request.get('/session', { baseUrl, json: true });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.err.message, 'session object cannot be reassigned');
  });

  it('should not throw for reassigining session to empty', async () => {
    server = await createServer((req, res, next) => {
      appSession(getConfig(defaultConfig))(req, res, () => {
        req.appSession = null;
        req.appSession = undefined;
        next();
      });
    });
    const res = await request.get('/session', { baseUrl, json: true });
    assert.equal(res.statusCode, 200);
  });

  it('should expire after 24hrs of inactivity by default', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    server = await createServer(appSession(getConfig(defaultConfig)));
    const jar = await login({ sub: '__test_sub__' });
    let res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isNotEmpty(res.body);
    clock.tick(23 * HR_MS);
    res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isNotEmpty(res.body);
    clock.tick(25 * HR_MS);
    res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isEmpty(res.body);
    clock.restore();
  });

  it('should expire after 7days regardless of activity by default', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    server = await createServer(appSession(getConfig(defaultConfig)));
    const jar = await login({ sub: '__test_sub__' });
    let days = 7;
    while (days--) {
      clock.tick(23 * HR_MS);
      let res = await request.get('/session', { baseUrl, jar, json: true });
      assert.isNotEmpty(res.body);
    }
    clock.tick(8 * HR_MS);
    let res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isEmpty(res.body);
    clock.restore();
  });

  it('should expire only after defined absoluteDuration', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    server = await createServer(
      appSession(
        getConfig({
          ...defaultConfig,
          session: {
            rolling: false,
            absoluteDuration: 10 * 60 * 60,
          },
        })
      )
    );
    const jar = await login({ sub: '__test_sub__' });
    clock.tick(9 * HR_MS);
    let res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isNotEmpty(res.body);
    clock.tick(2 * HR_MS);
    res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isEmpty(res.body);
    clock.restore();
  });

  it('should expire only after defined rollingDuration period of inactivty', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    server = await createServer(
      appSession(
        getConfig({
          ...defaultConfig,
          session: {
            rolling: true,
            rollingDuration: 24 * 60 * 60,
            absoluteDuration: false,
          },
        })
      )
    );
    const jar = await login({ sub: '__test_sub__' });
    let days = 30;
    while (days--) {
      clock.tick(23 * HR_MS);
      let res = await request.get('/session', { baseUrl, jar, json: true });
      assert.isNotEmpty(res.body);
    }
    clock.tick(25 * HR_MS);
    let res = await request.get('/session', { baseUrl, jar, json: true });
    assert.isEmpty(res.body);
    clock.restore();
  });
});