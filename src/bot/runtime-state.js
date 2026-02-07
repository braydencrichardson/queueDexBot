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
};
