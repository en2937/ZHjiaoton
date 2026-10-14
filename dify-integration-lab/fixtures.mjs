// These are invented API fixtures, never observations or output of the sandbox.
export function fixture(id) {
  const variants = {
    A: {version: 'fixture-A', branchShare: 20, main: 300, roundabout: 180, queued: 24},
    B: {version: 'fixture-B', branchShare: 60, main: 160, roundabout: 260, queued: 10},
  };
  const v = variants[id];
  if (!v) return null;
  return {
    schemaVersion: 'traffic-lab-v1', scenarioId: 'api-fixture-only', stateVersion: v.version,
    source: 'handcrafted-integration-fixture', sourceLabel: '人工构造的接口测试样例，非沙盘计算、非真实路况',
    updatedAt: new Date().toISOString(), simulationTimeSeconds: 600,
    settings: {branchShare: v.branchShare}, metrics: {queued: v.queued},
    routes: [
      {id: 'main', name: '主路', origin: '1', destination: '2', mode: 'electric', travelTimeSeconds: v.main, sampleCount: 20},
      {id: 'roundabout', name: '环岛', origin: '1', destination: '2', mode: 'electric', travelTimeSeconds: v.roundabout, sampleCount: 20},
    ],
    limitations: ['仅用于检查每轮状态传递，数值为人工设定', '未提供十分钟后的推演，不能给出未来耗时', '不能据此判断现有沙盘的策略效果'],
  };
}

export function makeEnvelope(question, state) {
  return JSON.stringify({
    protocol: 'traffic-lab-v1', question,
    instruction: '只依据本轮 state，历史对话中的路况已失效。回答应说明状态版本、模拟数据来源、路线耗时与建议依据；缺失数据不能推测。',
    state,
  });
}
