// scope 匹配：精确 / CIDR / 标签边界通配（授权边界安全，ADR-001 D3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScopeEntry } from '../packages/warroom-core/src/gates.js';

test('精确匹配不受影响', () => {
  assert.equal(inScopeEntry('app.example.com', 'app.example.com'), true);
  assert.equal(inScopeEntry('app.example.com', 'other.example.com'), false);
  assert.equal(inScopeEntry('10.0.0.5', '10.0.0.5'), true);
});

test('IPv4 CIDR 不受影响', () => {
  assert.equal(inScopeEntry('10.0.0.5', '10.0.0.0/24'), true);
  assert.equal(inScopeEntry('10.0.1.5', '10.0.0.0/24'), false);
  assert.equal(inScopeEntry('172.16.0.5', '10.0.0.0/24'), false);
});

test('通配命中自身与合法子域（标签边界内）', () => {
  assert.equal(inScopeEntry('app.example.com', 'app.example.com*'), true);        // 自身
  assert.equal(inScopeEntry('x.app.example.com', 'app.example.com*'), true);      // 子域
  assert.equal(inScopeEntry('a.b.app.example.com', 'app.example.com*'), true);    // 多级子域
});

test('越权子域后缀欺骗被拒（核心安全修复）', () => {
  // 攻击者在授权域右侧追加自有域，裸前缀匹配会误放行
  assert.equal(inScopeEntry('app.example.com.attacker.com', 'app.example.com*'), false);
  // 同标签后缀吞吃（无点边界）
  assert.equal(inScopeEntry('app.example.community', 'app.example.com*'), false);
  assert.equal(inScopeEntry('app.example.computers.evil', 'app.example.com*'), false);
});

test('裸 "*" 不授予全域（fail-closed）', () => {
  assert.equal(inScopeEntry('anything.evil.com', '*'), false);
  assert.equal(inScopeEntry('10.0.0.5', '*'), false);
});

test('"name.*" 写法等价于按基名的子域通配', () => {
  assert.equal(inScopeEntry('example.com', 'example.*'), false); // example.com 非 example 的子域
  assert.equal(inScopeEntry('example', 'example.*'), true);      // 基名自身
  assert.equal(inScopeEntry('x.example', 'example.*'), true);    // 子域
});
