self.onmessage = (e) => {
  self.postMessage('Worker received: ' + e.data);
};
