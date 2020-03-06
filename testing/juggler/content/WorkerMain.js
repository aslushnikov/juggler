"use strict";
loadSubScript('chrome://juggler/content/content/RuntimeAgent.js');
loadSubScript('chrome://juggler/content/SimpleChannel.js');

const runtimeAgents = new Map();

const channel = new SimpleChannel('worker::worker');
const eventListener = event => channel._onMessage(JSON.parse(event.data));
this.addEventListener('message', eventListener);
channel.transport = {
  sendMessage: msg => postMessage(JSON.stringify(msg)),
  dispose: () => this.removeEventListener('message', eventListener),
};

channel.register('', {
  attach: ({sessionId}) => {
    const runtimeAgent = new RuntimeAgent(channel, sessionId, true /* isWorker */);
    runtimeAgents.set(sessionId, runtimeAgent);
    runtimeAgent.createExecutionContext(null /* domWindow */, global, {});
    runtimeAgent.enable();
  },

  detach: ({sessionId}) => {
    const runtimeAgent = runtimeAgents.get(sessionId);
    runtimeAgents.delete(sessionId);
    runtimeAgent.dispose();
  },
});

