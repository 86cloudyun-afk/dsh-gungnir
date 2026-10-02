// 测试公共装置：临时目录 + fake adapter + 冻结授权（开工指令即授权的测试形态）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from './broker.js';
import { FakeAdapter } from './adapters/fake.js';

export function harness({ authOverrides = {}, faults = {}, nowMs, rng } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'warroom-test-'));
  const adapter = new FakeAdapter({ faults });
  const broker = new Broker({ home, adapter, nowMs, rng });
  const eng = broker.createEngagement({
    user_message_id: 'um-test-1',
    targets: ['10.0.0.0/24'],
    overrides: authOverrides,
  });
  const base = {
    engagement_id: eng.engagement_id,
    auth_version: eng.auth_version,
  };
  const contract = (over = {}) => ({
    targets: ['10.0.0.5'],
    action_class: 'active',
    resources: [],
    wire_cost: 1,
    fake_members: [{
      entity_type: 'asset',
      source_id: 'a-1',
      revision_no: 1,
      content_hash: 'h-a1',
      payload: { ip: '10.0.0.5' },
    }],
    ...over,
  });
  return { home, adapter, broker, eng, base, contract, store: () => broker._eng(eng.engagement_id).store };
}
