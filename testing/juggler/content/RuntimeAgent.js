"use strict";
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {addDebuggerToGlobal} = ChromeUtils.import("resource://gre/modules/jsdebugger.jsm", {});

const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
addDebuggerToGlobal(Cu.getGlobalForObject(this));
const helper = new Helper();

const consoleLevelToProtocolType = {
  'dir': 'dir',
  'log': 'log',
  'debug': 'debug',
  'info': 'info',
  'error': 'error',
  'warn': 'warning',
  'dirxml': 'dirxml',
  'table': 'table',
  'trace': 'trace',
  'clear': 'clear',
  'group': 'startGroup',
  'groupCollapsed': 'startGroupCollapsed',
  'groupEnd': 'endGroup',
  'assert': 'assert',
  'profile': 'profile',
  'profileEnd': 'profileEnd',
  'count': 'count',
  'countReset': 'countReset',
  'time': null,
  'timeLog': 'timeLog',
  'timeEnd': 'timeEnd',
  'timeStamp': 'timeStamp',
};

const disallowedMessageCategories = new Set([
  'XPConnect JavaScript',
  'component javascript',
  'chrome javascript',
  'chrome registration',
  'XBL',
  'XBL Prototype Handler',
  'XBL Content Sink',
  'xbl javascript',
]);

class RuntimeAgent {
  constructor(session) {
    this._debugger = new Debugger();
    this._pendingPromises = new Map();
    this._session = session;
    this._executionContexts = new Map();
    this._windowToExecutionContext = new Map();
    this._consoleServiceListener = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIConsoleListener]),

      observe: message => {
        if (!(message instanceof Ci.nsIScriptError) || !message.outerWindowID ||
            !message.category || disallowedMessageCategories.has(message.category)) {
          return;
        }
        const errorWindow = Services.wm.getOuterWindowWithId(message.outerWindowID);
        const executionContext = this._windowToExecutionContext.get(errorWindow);
        if (!executionContext)
          return;
        const typeNames = {
          [Ci.nsIConsoleMessage.debug]: 'debug',
          [Ci.nsIConsoleMessage.info]: 'info',
          [Ci.nsIConsoleMessage.warn]: 'warn',
          [Ci.nsIConsoleMessage.error]: 'error',
        };
        this._session.emitEvent('Runtime.console', {
          args: [{
            value: message.message,
          }],
          type: typeNames[message.logLevel],
          executionContextId: executionContext.id(),
          location: {
            lineNumber: message.lineNumber,
            columnNumber: message.columnNumber,
            url: message.sourceName,
          },
        });
      },
    };

    this._eventListeners = [];
    this._enabled = false;
  }

  rawElementToRemoteObject(node) {
    const executionContext = Array.from(this._executionContexts.values()).find(context => node.ownerDocument == context._domWindow.document);
    return {
      executionContextId: executionContext.id(),
      element: executionContext.rawValueToRemoteObject(node)
    };
  }

  _consoleAPICalled({wrappedJSObject}, topic, data) {
    const type = consoleLevelToProtocolType[wrappedJSObject.level];
    if (!type)
      return;
    const executionContext = Array.from(this._executionContexts.values()).find(context => {
      const domWindow = context._domWindow;
      return domWindow && domWindow.windowUtils.currentInnerWindowID === wrappedJSObject.innerID;
    });
    if (!executionContext)
      return;
    const args = wrappedJSObject.arguments.map(arg => executionContext.rawValueToRemoteObject(arg));
    this._session.emitEvent('Runtime.console', {
      args,
      type,
      executionContextId: executionContext.id(),
      location: {
        lineNumber: wrappedJSObject.lineNumber - 1,
        columnNumber: wrappedJSObject.columnNumber - 1,
        url: wrappedJSObject.filename,
      },
    });
  }

  enable() {
    if (this._enabled)
      return;
    this._enabled = true;
    for (const executionContext of this._executionContexts.values())
      this._notifyExecutionContextCreated(executionContext);
    Services.console.registerListener(this._consoleServiceListener);
    this._eventListeners = [
      () => Services.console.unregisterListener(this._consoleServiceListener),
      helper.addObserver(this._consoleAPICalled.bind(this), "console-api-log-event"),
    ];
  }

  _notifyExecutionContextCreated(executionContext) {
    if (!this._enabled)
      return;
    this._session.emitEvent('Runtime.executionContextCreated', {
      executionContextId: executionContext._id,
      auxData: executionContext._auxData,
    });
  }

  _notifyExecutionContextDestroyed(executionContext) {
    if (!this._enabled)
      return;
    this._session.emitEvent('Runtime.executionContextDestroyed', {
      executionContextId: executionContext._id,
    });
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
  }

  async _awaitPromise(executionContext, obj, exceptionDetails = {}) {
    if (obj.promiseState === 'fulfilled')
      return {success: true, obj: obj.promiseValue};
    if (obj.promiseState === 'rejected') {
      const global = executionContext._global;
      exceptionDetails.text = global.executeInGlobalWithBindings('e.message', {e: obj.promiseReason}).return;
      exceptionDetails.stack = global.executeInGlobalWithBindings('e.stack', {e: obj.promiseReason}).return;
      return {success: false, obj: null};
    }
    let resolve, reject;
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    this._pendingPromises.set(obj.promiseID, {resolve, reject, executionContext, exceptionDetails});
    if (this._pendingPromises.size === 1)
      this._debugger.onPromiseSettled = this._onPromiseSettled.bind(this);
    return await promise;
  }

  _onPromiseSettled(obj) {
    const pendingPromise = this._pendingPromises.get(obj.promiseID);
    if (!pendingPromise)
      return;
    this._pendingPromises.delete(obj.promiseID);
    if (!this._pendingPromises.size)
      this._debugger.onPromiseSettled = undefined;

    if (obj.promiseState === 'fulfilled') {
      pendingPromise.resolve({success: true, obj: obj.promiseValue});
      return;
    };
    const global = pendingPromise.executionContext._global;
    pendingPromise.exceptionDetails.text = global.executeInGlobalWithBindings('e.message', {e: obj.promiseReason}).return;
    pendingPromise.exceptionDetails.stack = global.executeInGlobalWithBindings('e.stack', {e: obj.promiseReason}).return;
    pendingPromise.resolve({success: false, obj: null});
  }

  createExecutionContext(domWindow, auxData) {
    const context = new ExecutionContext(this, domWindow, this._debugger.addDebuggee(domWindow), auxData);
    this._executionContexts.set(context._id, context);
    this._windowToExecutionContext.set(domWindow, context);
    this._notifyExecutionContextCreated(context);
    return context;
  }

  destroyExecutionContext(destroyedContext) {
    for (const [promiseID, {reject, executionContext}] of this._pendingPromises) {
      if (executionContext === destroyedContext) {
        reject(new Error('Execution context was destroyed!'));
        this._pendingPromises.delete(promiseID);
      }
    }
    if (!this._pendingPromises.size)
      this._debugger.onPromiseSettled = undefined;
    this._debugger.removeDebuggee(destroyedContext._domWindow);
    this._executionContexts.delete(destroyedContext._id);
    this._windowToExecutionContext.delete(destroyedContext._domWindow);
    this._notifyExecutionContextDestroyed(destroyedContext);
  }

  async evaluate({executionContextId, expression, returnByValue}) {
    const executionContext = this._executionContexts.get(executionContextId);
    if (!executionContext)
      throw new Error('Failed to find execution context with id = ' + executionContextId);
    const exceptionDetails = {};
    let result = await executionContext.evaluateScript(expression, exceptionDetails);
    if (!result)
      return {exceptionDetails};
    if (returnByValue)
      result = executionContext.ensureSerializedToValue(result);
    return {result};
  }

  async callFunction({executionContextId, functionDeclaration, args, returnByValue}) {
    const executionContext = this._executionContexts.get(executionContextId);
    if (!executionContext)
      throw new Error('Failed to find execution context with id = ' + executionContextId);
    const exceptionDetails = {};
    let result = await executionContext.evaluateFunction(functionDeclaration, args, exceptionDetails);
    if (!result)
      return {exceptionDetails};
    if (returnByValue)
      result = executionContext.ensureSerializedToValue(result);
    return {result};
  }

  async getObjectProperties({executionContextId, objectId}) {
    const executionContext = this._executionContexts.get(executionContextId);
    if (!executionContext)
      throw new Error('Failed to find execution context with id = ' + executionContextId);
    return {properties: executionContext.getObjectProperties(objectId)};
  }

  async disposeObject({executionContextId, objectId}) {
    const executionContext = this._executionContexts.get(executionContextId);
    if (!executionContext)
      throw new Error('Failed to find execution context with id = ' + executionContextId);
    return executionContext.disposeObject(objectId);
  }
}

class ExecutionContext {
  constructor(runtime, domWindow, global, auxData) {
    this._runtime = runtime;
    this._domWindow = domWindow;
    this._global = global;
    this._remoteObjects = new Map();
    this._id = helper.generateId();
    this._auxData = auxData;
    this._jsonStringifyObject = this._global.executeInGlobal('JSON.stringify.bind(JSON)').return;
  }

  id() {
    return this._id;
  }

  async evaluateScript(script, exceptionDetails = {}) {
    const userInputHelper = this._domWindow.windowUtils.setHandlingUserInput(true);
    let {success, obj} = this._getResult(this._global.executeInGlobal(script), exceptionDetails);
    userInputHelper.destruct();
    if (!success)
      return null;
    if (obj && obj.isPromise) {
      const awaitResult = await this._runtime._awaitPromise(this, obj, exceptionDetails);
      if (!awaitResult.success)
        return null;
      obj = awaitResult.obj;
    }
    return this._createRemoteObject(obj);
  }

  async evaluateFunction(functionText, args, exceptionDetails = {}) {
    const funEvaluation = this._getResult(this._global.executeInGlobal('(' + functionText + ')'), exceptionDetails);
    if (!funEvaluation.success)
      return null;
    if (!funEvaluation.obj.callable)
      throw new Error('functionText does not evaluate to a function!');
    args = args.map(arg => {
      if (arg.objectId) {
        if (!this._remoteObjects.has(arg.objectId))
          throw new Error('Cannot find object with id = ' + arg.objectId);
        return this._remoteObjects.get(arg.objectId);
      }
      switch (arg.unserializableValue) {
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        case '-0': return -0;
        case 'NaN': return NaN;
        default: return this._toDebugger(arg.value);
      }
    });
    const userInputHelper = this._domWindow.windowUtils.setHandlingUserInput(true);
    let {success, obj} = this._getResult(funEvaluation.obj.apply(null, args), exceptionDetails);
    userInputHelper.destruct();
    if (!success)
      return null;
    if (obj && obj.isPromise) {
      const awaitResult = await this._runtime._awaitPromise(this, obj, exceptionDetails);
      if (!awaitResult.success)
        return null;
      obj = awaitResult.obj;
    }
    return this._createRemoteObject(obj);
  }

  unsafeObject(objectId) {
    if (!this._remoteObjects.has(objectId))
      throw new Error('Cannot find object with id = ' + objectId);
    return this._remoteObjects.get(objectId).unsafeDereference();
  }

  rawValueToRemoteObject(rawValue) {
    const debuggerObj = this._global.makeDebuggeeValue(rawValue);
    return this._createRemoteObject(debuggerObj);
  }

  _createRemoteObject(debuggerObj) {
    if (debuggerObj instanceof Debugger.Object) {
      const objectId = helper.generateId();
      this._remoteObjects.set(objectId, debuggerObj);
      const rawObj = debuggerObj.unsafeDereference();
      const type = typeof rawObj;
      let subtype = undefined;
      if (debuggerObj.isProxy)
        subtype = 'proxy';
      else if (Array.isArray(rawObj))
        subtype = 'array';
      else if (Object.is(rawObj, null))
        subtype = 'null';
      else if (rawObj instanceof this._domWindow.Node)
        subtype = 'node';
      else if (rawObj instanceof this._domWindow.RegExp)
        subtype = 'regexp';
      else if (rawObj instanceof this._domWindow.Date)
        subtype = 'date';
      else if (rawObj instanceof this._domWindow.Map)
        subtype = 'map';
      else if (rawObj instanceof this._domWindow.Set)
        subtype = 'set';
      else if (rawObj instanceof this._domWindow.WeakMap)
        subtype = 'weakmap';
      else if (rawObj instanceof this._domWindow.WeakSet)
        subtype = 'weakset';
      else if (rawObj instanceof this._domWindow.Error)
        subtype = 'error';
      else if (rawObj instanceof this._domWindow.Promise)
        subtype = 'promise';
      else if ((rawObj instanceof this._domWindow.Int8Array) || (rawObj instanceof this._domWindow.Uint8Array) ||
               (rawObj instanceof this._domWindow.Uint8ClampedArray) || (rawObj instanceof this._domWindow.Int16Array) ||
               (rawObj instanceof this._domWindow.Uint16Array) || (rawObj instanceof this._domWindow.Int32Array) ||
               (rawObj instanceof this._domWindow.Uint32Array) || (rawObj instanceof this._domWindow.Float32Array) ||
               (rawObj instanceof this._domWindow.Float64Array)) {
        subtype = 'typedarray';
      }
      return {objectId, type, subtype};
    }
    if (typeof debuggerObj === 'symbol') {
      const objectId = helper.generateId();
      this._remoteObjects.set(objectId, debuggerObj);
      return {objectId, type: 'symbol'};
    }

    let unserializableValue = undefined;
    if (Object.is(debuggerObj, NaN))
      unserializableValue = 'NaN';
    else if (Object.is(debuggerObj, -0))
      unserializableValue = '-0';
    else if (Object.is(debuggerObj, Infinity))
      unserializableValue = 'Infinity';
    else if (Object.is(debuggerObj, -Infinity))
      unserializableValue = '-Infinity';
    return unserializableValue ? {unserializableValue} : {value: debuggerObj};
  }

  ensureSerializedToValue(protocolObject) {
    if (!protocolObject.objectId)
      return protocolObject;
    const obj = this._remoteObjects.get(protocolObject.objectId);
    this._remoteObjects.delete(protocolObject.objectId);
    return {value: this._serialize(obj)};
  }

  _toDebugger(obj) {
    if (typeof obj !== 'object')
      return obj;
    const properties = {};
    for (let [key, value] of Object.entries(obj)) {
      properties[key] = {
        writable: true,
        enumerable: true,
        value: this._toDebugger(value),
      };
    }
    const baseObject = Array.isArray(obj) ? '([])' : '({})';
    const debuggerObj = this._global.executeInGlobal(baseObject).return;
    debuggerObj.defineProperties(properties);
    return debuggerObj;
  }

  _serialize(obj) {
    const result = this._global.executeInGlobalWithBindings('stringify(e)', {e: obj, stringify: this._jsonStringifyObject});
    if (result.throw)
      throw new Error('Object is not serializable');
    return JSON.parse(result.return);
  }

  disposeObject(objectId) {
    this._remoteObjects.delete(objectId);
  }

  getObjectProperties(objectId) {
    if (!this._remoteObjects.has(objectId))
      throw new Error('Cannot find object with id = ' + arg.objectId);
    const result = [];
    for (let obj = this._remoteObjects.get(objectId); obj; obj = obj.proto) {
      for (const propertyName of obj.getOwnPropertyNames()) {
        const descriptor = obj.getOwnPropertyDescriptor(propertyName);
        if (!descriptor.enumerable)
          continue;
        result.push({
          name: propertyName,
          value: this._createRemoteObject(descriptor.value),
        });
      }
    }
    return result;
  }

  _getResult(completionValue, exceptionDetails = {}) {
    if (!completionValue) {
      exceptionDetails.text = 'Evaluation terminated!';
      exceptionDetails.stack = '';
      return {success: false, obj: null};
    }
    if (completionValue.throw) {
      if (this._global.executeInGlobalWithBindings('e instanceof Error', {e: completionValue.throw}).return) {
        exceptionDetails.text = this._global.executeInGlobalWithBindings('e.message', {e: completionValue.throw}).return;
        exceptionDetails.stack = this._global.executeInGlobalWithBindings('e.stack', {e: completionValue.throw}).return;
      } else {
        exceptionDetails.value = this._serialize(completionValue.throw);
      }
      return {success: false, obj: null};
    }
    return {success: true, obj: completionValue.return};
  }
}

var EXPORTED_SYMBOLS = ['RuntimeAgent'];
this.RuntimeAgent = RuntimeAgent;
