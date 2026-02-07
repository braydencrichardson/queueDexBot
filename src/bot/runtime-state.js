const SEARCH_CHOOSER_MAX_RESULTS = 5;

function createRuntimeState() {
  return {
    queues: new Map(),
    queueViews: new Map(),
    pendingSearches: new Map(),
    pendingMoves: new Map(),
    pendingQueuedActions: new Map(),
  };
}

module.exports = {
  createRuntimeState,
  SEARCH_CHOOSER_MAX_RESULTS,
};
