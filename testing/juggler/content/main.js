const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {FrameTree} = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const {NetworkMonitor} = ChromeUtils.import('chrome://juggler/content/content/NetworkMonitor.js');
const {ScrollbarManager} = ChromeUtils.import('chrome://juggler/content/content/ScrollbarManager.js');
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const {RuntimeAgent} = ChromeUtils.import('chrome://juggler/content/content/RuntimeAgent.js');
const {PageAgent} = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');

const scrollbarManager = new ScrollbarManager(docShell);
let frameTree;
let networkMonitor;
const helper = new Helper();
const messageManager = this;

const sessions = new Map();

function createContentSession(channel, sessionId) {
  const runtimeAgent = new RuntimeAgent(channel, sessionId);
  const pageAgent = new PageAgent(messageManager, channel, sessionId, runtimeAgent, frameTree, networkMonitor);
  sessions.set(sessionId, [runtimeAgent, pageAgent]);

  runtimeAgent.enable();
  pageAgent.enable();
}

function disposeContentSession(sessionId) {
  const handlers = sessions.get(sessionId);
  sessions.delete(sessionId);
  for (const handler of handlers)
    handler.dispose();
}

function initialize() {
  let response = sendSyncMessage('juggler:content-ready', {})[0];
  if (!response)
    response = { sessionIds: [], browserContextOptions: {}, waitForInitialNavigation: false };

  const { sessionIds, browserContextOptions, waitForInitialNavigation } = response;
  const { userAgent, bypassCSP, javaScriptDisabled, viewport, scriptsToEvaluateOnNewDocument } = browserContextOptions;

  if (userAgent !== undefined)
    docShell.customUserAgent = userAgent;
  if (bypassCSP !== undefined)
    docShell.bypassCSPEnabled = bypassCSP;
  if (javaScriptDisabled !== undefined)
    docShell.allowJavascript = !javaScriptDisabled;
  if (viewport !== undefined) {
    docShell.contentViewer.overrideDPPX = viewport.deviceScaleFactor || this._initialDPPX;
    docShell.deviceSizeIsPageSize = viewport.isMobile;
    docShell.touchEventsOverride = viewport.hasTouch ? Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_ENABLED : Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_NONE;
    scrollbarManager.setFloatingScrollbars(viewport.isMobile);
  }

  frameTree = new FrameTree(docShell, waitForInitialNavigation);
  for (const script of scriptsToEvaluateOnNewDocument || [])
    frameTree.addScriptToEvaluateOnNewDocument(script);
  networkMonitor = new NetworkMonitor(docShell, frameTree);

  const channel = SimpleChannel.createForMessageManager('content::page', messageManager);

  for (const sessionId of sessionIds)
    createContentSession(channel, sessionId);

  channel.register('', {
    attach({sessionId}) {
      createContentSession(channel, sessionId);
    },

    detach({sessionId}) {
      disposeContentSession(sessionId);
    },

    addScriptToEvaluateOnNewDocument({script}) {
      frameTree.addScriptToEvaluateOnNewDocument(script);
    },

    dispose() {
    },
  });

  const gListeners = [
    helper.addEventListener(messageManager, 'unload', msg => {
      helper.removeListeners(gListeners);
      channel.dispose();

      for (const sessionId of sessions.keys())
        disposeContentSession(sessionId);

      scrollbarManager.dispose();
      networkMonitor.dispose();
      frameTree.dispose();
    }),
  ];
}

initialize();
