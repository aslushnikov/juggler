const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {protocol, checkScheme} = ChromeUtils.import("chrome://juggler/content/protocol/Protocol.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const helper = new Helper();
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');

const PROTOCOL_HANDLERS = {
  Page: ChromeUtils.import("chrome://juggler/content/protocol/PageHandler.js").PageHandler,
  Network: ChromeUtils.import("chrome://juggler/content/protocol/NetworkHandler.js").NetworkHandler,
  Browser: ChromeUtils.import("chrome://juggler/content/protocol/BrowserHandler.js").BrowserHandler,
  Runtime: ChromeUtils.import("chrome://juggler/content/protocol/RuntimeHandler.js").RuntimeHandler,
  Accessibility: ChromeUtils.import("chrome://juggler/content/protocol/AccessibilityHandler.js").AccessibilityHandler,
};

class Dispatcher {
  /**
   * @param {Connection} connection
   */
  constructor(connection) {
    this._connection = connection;
    this._connection.onmessage = this._dispatch.bind(this);
    this._connection.onclose = this._dispose.bind(this);

    this._targetSessions = new Map();
    this._sessions = new Map();
    this._rootSession = new ChromeSession(this, undefined, null /* contentChannel */, TargetRegistry.instance().browserTargetInfo());

    this._eventListeners = [
      helper.on(TargetRegistry.instance(), TargetRegistry.Events.TargetDestroyed, this._onTargetDestroyed.bind(this)),
    ];
  }

  createSession(targetId, shouldConnect) {
    const targetInfo = TargetRegistry.instance().targetInfo(targetId);
    if (!targetInfo)
      throw new Error(`Target "${targetId}" is not found`);
    let targetSessions = this._targetSessions.get(targetId);
    if (!targetSessions) {
      targetSessions = new Map();
      this._targetSessions.set(targetId, targetSessions);
    }

    const sessionId = helper.generateId();
    const contentChannel = targetInfo.type === 'page' ? TargetRegistry.instance().contentChannelForTarget(targetInfo.targetId) : null;
    if (shouldConnect && contentChannel)
      contentChannel.connect('').send('attach', {sessionId});
    const chromeSession = new ChromeSession(this, sessionId, contentChannel, targetInfo);
    targetSessions.set(sessionId, chromeSession);
    this._sessions.set(sessionId, chromeSession);
    return sessionId;
  }

  _dispose() {
    helper.removeListeners(this._eventListeners);
    this._connection.onmessage = null;
    this._connection.onclose = null;
    this._rootSession.dispose();
    this._rootSession = null;
    for (const session of this._sessions.values())
      session.dispose();
    this._sessions.clear();
    this._targetSessions.clear();
  }

  _onTargetDestroyed(target) {
    const targetId = target.id();
    const sessions = this._targetSessions.get(targetId);
    if (!sessions)
      return;
    this._targetSessions.delete(targetId);
    for (const [sessionId, session] of sessions) {
      session.dispose();
      this._sessions.delete(sessionId);
    }
  }

  async _dispatch(event) {
    const data = JSON.parse(event.data);
    const id = data.id;
    const sessionId = data.sessionId;
    delete data.sessionId;
    try {
      const session = sessionId ? this._sessions.get(sessionId) : this._rootSession;
      if (!session)
        throw new Error(`ERROR: cannot find session with id "${sessionId}"`);
      const method = data.method;
      const params = data.params || {};
      if (!id)
        throw new Error(`ERROR: every message must have an 'id' parameter`);
      if (!method)
        throw new Error(`ERROR: every message must have a 'method' parameter`);

      const [domain, methodName] = method.split('.');
      const descriptor = protocol.domains[domain] ? protocol.domains[domain].methods[methodName] : null;
      if (!descriptor)
        throw new Error(`ERROR: method '${method}' is not supported`);
      let details = {};
      if (!checkScheme(descriptor.params || {}, params, details))
        throw new Error(`ERROR: failed to call method '${method}' with parameters ${JSON.stringify(params, null, 2)}\n${details.error}`);

      const result = await session.dispatch(method, params);

      details = {};
      if ((descriptor.returns || result) && !checkScheme(descriptor.returns, result, details))
        throw new Error(`ERROR: failed to dispatch method '${method}' result ${JSON.stringify(result, null, 2)}\n${details.error}`);

      this._connection.send(JSON.stringify({id, sessionId, result}));
    } catch (e) {
      this._connection.send(JSON.stringify({id, sessionId, error: {
        message: e.message,
        data: e.stack
      }}));
    }
  }

  _emitEvent(sessionId, eventName, params) {
    const [domain, eName] = eventName.split('.');
    const scheme = protocol.domains[domain] ? protocol.domains[domain].events[eName] : null;
    if (!scheme)
      throw new Error(`ERROR: event '${eventName}' is not supported`);
    const details = {};
    if (!checkScheme(scheme, params || {}, details))
      throw new Error(`ERROR: failed to emit event '${eventName}' ${JSON.stringify(params, null, 2)}\n${details.error}`);
    this._connection.send(JSON.stringify({method: eventName, params, sessionId}));
  }
}

class ChromeSession {
  /**
   * @param {Connection} connection
   */
  constructor(dispatcher, sessionId, contentChannel, targetInfo) {
    this._dispatcher = dispatcher;
    this._sessionId = sessionId;
    this._contentChannel = contentChannel;
    this._targetInfo = targetInfo;

    this._handlers = {};
    for (const [domainName, handlerFactory] of Object.entries(PROTOCOL_HANDLERS)) {
      if (protocol.domains[domainName].targets.includes(targetInfo.type))
        this._handlers[domainName] = new handlerFactory(this, sessionId, contentChannel);
    }
    const pageHandler = this._handlers['Page'];
    if (pageHandler)
      pageHandler.enable();
    const networkHandler = this._handlers['Network'];
    if (networkHandler)
      networkHandler.enable();
  }

  dispatcher() {
    return this._dispatcher;
  }

  targetId() {
    return this._targetInfo.targetId;
  }

  dispose() {
    if (this._contentChannel)
      this._contentChannel.connect('').emit('detach', {sessionId: this._sessionId});
    this._contentChannel = null;
    for (const [domainName, handler] of Object.entries(this._handlers)) {
      if (!handler.dispose)
        throw new Error(`Handler for "${domainName}" domain does not define |dispose| method!`);
      handler.dispose();
      delete this._handlers[domainName];
    }
    // Root session don't have sessionId and don't emit detachedFromTarget.
    if (this._sessionId) {
      this._dispatcher._emitEvent(this._dispatcher._rootSession._sessionId, 'Browser.detachedFromTarget', {
        sessionId: this._sessionId,
        targetId: this.targetId(),
      });
    }
  }

  emitEvent(eventName, params) {
    this._dispatcher._emitEvent(this._sessionId, eventName, params);
  }

  async dispatch(method, params) {
    const [domainName, methodName] = method.split('.');
    if (!this._handlers[domainName])
      throw new Error(`Domain "${domainName}" does not exist`);
    if (!this._handlers[domainName][methodName])
      throw new Error(`Handler for domain "${domainName}" does not implement method "${methodName}"`);
    return await this._handlers[domainName][methodName](params);
  }
}

this.EXPORTED_SYMBOLS = ['Dispatcher'];
this.Dispatcher = Dispatcher;

