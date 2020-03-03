"use strict";
loadSubScript('chrome://juggler/content/content/RuntimeAgent.js');

class WorkerSession {
  constructor(workerId) {
    this._workerId = workerId;
    this._agents = {
      Runtime: new RuntimeAgent(this, hash => this._send({command: 'console', hash})),
    };
    this._agents.Runtime.enable();
    this._agents.Runtime.createExecutionContext(null /* domWindow */, global, {});
  }

  _send(command) {
    postMessage(JSON.stringify({...command, workerId: this._workerId}));
  }

  _dispatchProtocolMessage(protocolMessage) {
    this._send({command: 'dispatch', message: JSON.stringify(protocolMessage)});
  }

  emitEvent(eventName, params) {
    this._dispatchProtocolMessage({method: eventName, params});
  }

  async _onMessage(message) {
    const object = JSON.parse(message);
    const id = object.id;
    try {
      const [domainName, methodName] = object.method.split('.');
      const agent = this._agents[domainName];
      if (!agent)
        throw new Error(`unknown domain: ${domainName}`);
      const handler = agent[methodName];
      if (!handler)
        throw new Error(`unknown method: ${domainName}.${methodName}`);
      const result = await handler.call(agent, object.params);
      this._dispatchProtocolMessage({id, result});
    } catch (e) {
      this._dispatchProtocolMessage({id, error: e.message + '\n' + e.stack});
    }
  }

  dispose() {
    for (const agent of Object.values(this._agents))
      agent.dispose();
  }
}

const workerSessions = new Map();

this.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (data.command === 'connect') {
    const session = new WorkerSession(data.workerId);
    workerSessions.set(data.workerId, session);
  }
  if (data.command === 'disconnect') {
    const session = workerSessions.get(data.workerId);
    session.dispose();
    workerSessions.delete(data.workerId);
  }
  if (data.command === 'dispatch') {
    const session = workerSessions.get(data.workerId);
    session._onMessage(data.message);
  }
});
