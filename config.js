export default {
  scoring: {
    RLM: 2,
    STEAM: 2,
    KEYNUM: 1.5,
    LATE: 1.5,
    OUTLIER: 1,
    SPLIT: 1
  },
  thresholds: {
    strong: 5,
    lean: 3
  },
  reAlert: {
    cooldownMinutes: 20,
    expiryMinutes: 240
  },
  stateFile: "./sharp_state.json"
};

