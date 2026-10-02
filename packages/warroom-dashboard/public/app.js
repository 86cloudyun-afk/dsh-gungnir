import { layoutGraph, focusedSubgraph, collapseEvidence, findExactNode } from './graph.js';
import { requestData } from './transport.js';

const $ = (selector) => document.querySelector(selector);
const state = { snapshot: null, selectedId: null, engagement: '', session: '', demo: false, sessions: [], engagementError: null, sessionError: null, generation: 0, controller: null, full: false, collapsed: false };
const layerNames = ['L0 · 入口 / 跳板', 'L1 · 资产', 'L2 · 证据', 'L3 · 链路', 'L4 · 结论'];

boot().catch(showError);

async function boot() {
  bindControls();
  setStatus('正在读取战役、会话与快照…');
  const [engagementResponse, sessionResponse] = await Promise.allSettled([requestData('/api/engagements'), requestData('/api/sessions')]);
  const engagements = engagementResponse.status === 'fulfilled' ? listFrom(engagementResponse.value, ['engagements', 'items']) : [];
  const sessions = sessionResponse.status === 'fulfilled' ? listFrom(sessionResponse.value, ['sessions', 'items']) : [];
  state.sessions = sessions;
  state.engagementError = engagementResponse.status === 'rejected' ? engagementResponse.reason : null;
  state.sessionError = sessionResponse.status === 'rejected' ? sessionResponse.reason : null;
  fillSelect($('#engagement-select'), engagements, 'engagement_id', 'name', '没有可用战役');
  fillSelect($('#session-select'), sessions, 'id', 'title', sessions.length ? '未选择会话 / 对话未接入' : '对话未接入', true);
  if (engagements.length) {
    state.engagement = idOf(engagements[0], 'engagement_id', 'id');
    $('#engagement-select').value = state.engagement;
  }
  if (sessions.length === 1) {
    state.session = idOf(sessions[0], 'id');
    $('#session-select').value = state.session;
  }
  await refresh({ initial: true });
}

function bindControls() {
  $('#refresh-button').addEventListener('click', () => refresh());
  $('#engagement-select').addEventListener('change', (event) => { state.engagement = event.target.value; state.demo = false; state.selectedId = null; refresh({ reset: true }); });
  $('#session-select').addEventListener('change', (event) => { state.session = event.target.value; state.demo = false; state.selectedId = null; refresh({ reset: true }); });
  $('#demo-button').addEventListener('click', () => { state.demo = true; state.selectedId = null; refresh({ reset: true }); });
  $('#real-button').addEventListener('click', () => { state.demo = false; state.selectedId = null; refresh({ reset: true }); });
  $('#full-mode').addEventListener('click', (event) => { state.full = !state.full; event.currentTarget.setAttribute('aria-pressed', String(state.full)); $('.map-workspace').classList.toggle('full-mode', state.full); render(); });
  $('#collapse-evidence').addEventListener('click', (event) => { state.collapsed = !state.collapsed; event.currentTarget.setAttribute('aria-pressed', String(state.collapsed)); render(); });
  $('#clear-focus').addEventListener('click', () => { state.selectedId = null; render(); });
  $('#search-button').addEventListener('click', searchExact);
  $('#map-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchExact(); });
  $('#zoom-in').addEventListener('click', () => zoomBy(1.2));
  $('#zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
  $('#fit-map').addEventListener('click', fitMap);
  for (const svg of [$('#global-graph'), $('#focus-graph')]) {
    svg.addEventListener('click', (event) => { const node = event.target.closest('[data-node-id]'); if (node) selectNode(node.dataset.nodeId, true); });
    svg.addEventListener('keydown', (event) => { if (event.key !== 'Enter' && event.key !== ' ') return; const node = event.target.closest('[data-node-id]'); if (node) { event.preventDefault(); selectNode(node.dataset.nodeId, true); } });
    enablePanZoom(svg);
  }
  $('#messages').addEventListener('click', (event) => {
    const ref = event.target.closest('[data-node-ref]');
    const message = event.target.closest('[data-message-id]');
    if (ref) selectNode(ref.dataset.nodeRef, true);
    else if (message) {
      const nodeId = state.snapshot?.conversation?.messages?.find((item) => item.id === message.dataset.messageId)?.node_ids?.[0];
      if (nodeId) selectNode(nodeId, true);
    }
  });
}

async function refresh({ reset = false, initial = false } = {}) {
  const generation = ++state.generation;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const oldSelection = state.selectedId;
  if (reset || initial) {
    state.snapshot = null;
    state.selectedId = null;
    clearRenderedData();
  }
  setStatus('正在读取快照…');
  $('#global-error').hidden = true;
  if (state.engagementError && !state.demo) {
    state.snapshot = null;
    state.selectedId = null;
    clearRenderedData();
    showError(new Error(`战役列表读取失败：${state.engagementError.message || state.engagementError}`));
    return;
  }
  if (!state.demo && !state.engagement) {
    state.snapshot = null;
    state.selectedId = null;
    clearRenderedData();
    setStatus('真实数据不可用 · 没有可绑定战役 · 可显式选择演示数据');
    $('#mode-badge').textContent = '真实数据 · 空';
    $('#messages').append(element('p', { class: 'hint', style: 'padding:10px' }, '当前无战役数据。选择战役或点击“演示数据”查看合成示例。'));
    $('#global-error').hidden = true;
    return;
  }
  try {
    const endpoint = state.demo ? '/api/demo' : `/api/snapshot?engagement=${encodeURIComponent(state.engagement)}${state.session ? `&session=${encodeURIComponent(state.session)}` : ''}`;
    const snapshot = await requestData(endpoint, { signal: controller.signal });
    if (generation !== state.generation) return;
    if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) throw new Error('快照格式无效');
    if (!state.demo && !state.session && snapshot.conversation) {
      snapshot.conversation = { ...snapshot.conversation, status: 'unavailable', messages: [] };
    }
    state.snapshot = snapshot;
    const sameEngagement = oldSelection && snapshot.engagement?.engagement_id === state.engagement;
    state.selectedId = sameEngagement && snapshot.nodes.some((node) => node.id === oldSelection) ? oldSelection : null;
    render();
    setStatus(statusText(snapshot));
  } catch (error) {
    if (generation !== state.generation || error.name === 'AbortError') return;
    state.snapshot = null;
    state.selectedId = null;
    clearRenderedData();
    showError(error);
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  renderRoutes(snapshot);
  renderMessages(snapshot);
  renderGraph($('#global-graph'), snapshot, null);
  const focus = state.selectedId ? focusedSubgraph(snapshot, state.selectedId) : null;
  const focusedNodes = focus ? new Set(focus.node_ids) : new Set();
  const localSnapshot = focus ? { ...snapshot, nodes: snapshot.nodes.filter((node) => focusedNodes.has(node.id)), edges: snapshot.edges.filter((edge) => focus.edge_ids.includes(edge.id)) } : { ...snapshot, nodes: [], edges: [] };
  renderGraph($('#focus-graph'), localSnapshot, focus, {
    direction: 'LR',
    nodeWidth: 176,
    nodeHeight: 32,
    itemGap: 8,
    rankGap: 208,
  });
  $('#breadcrumb').textContent = state.selectedId ? breadcrumb(snapshot, state.selectedId) : '全局';
  renderSelectionTether(snapshot);
  renderDetail(snapshot);
  renderAnomalies(snapshot, focus);
  renderTether();
  const diag = snapshot.diagnostics || {};
  const shell = diag.shell_state;
  const failedCount = snapshot.nodes.filter((node) => node.state === 'failed').length + (snapshot.routes || []).filter((route) => route.egress?.verdict === 'fail').length;
  const pendingCount = snapshot.nodes.filter((node) => node.state === 'pending').length + (snapshot.routes || []).filter((route) => route.egress?.verdict === 'pending' || (route.egress?.verdict === 'pass' && route.egress?.current === false)).length;
  const expiredCount = (snapshot.routes || []).filter((route) => route.lease?.state === 'expired').length;
  $('#alert-summary').textContent = `${shell ? `历史最高证明 ${shell.highest_proof || '未知'} · 当前有效性 ${shell.current_validity || '未知'} · ` : ''}失败 ${failedCount} · 待核验/旧记录 ${pendingCount} · 租约过期 ${expiredCount}`;
  $('#mode-badge').textContent = snapshot.mode === 'demo' ? '演示数据 · synthetic' : '真实数据';
  $('#demo-button').setAttribute('aria-pressed', String(snapshot.mode === 'demo'));
  $('#real-button').setAttribute('aria-pressed', String(snapshot.mode !== 'demo'));
  if (snapshot.mode === 'demo') setStatus('演示数据 · synthetic · 不代表真实战役');
}

function renderGraph(svg, snapshot, focus, options = {}) {
  const renderSnapshot = svg.id === 'global-graph' && state.collapsed ? withCollapsedEvidence(snapshot) : snapshot;
  const layout = layoutGraph(renderSnapshot, options);
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${layout.bounds.width} ${layout.bounds.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.dataset.baseViewBox = `0 0 ${layout.bounds.width} ${layout.bounds.height}`;
  const defs = element('defs');
  const marker = element('marker', { id: `${svg.id}-arrow`, markerWidth: '7', markerHeight: '7', refX: '6', refY: '3.5', orient: 'auto' });
  marker.append(element('path', { d: 'M0,0 L7,3.5 L0,7 z', fill: '#87949d' }));
  defs.append(marker); svg.append(defs);
  const layers = element('g', { class: 'layers' });
  for (let layer = 0; layer < 5; layer += 1) {
    if (options.direction === 'LR') {
      const x = 48 + layer * layout.bounds.rankGap;
      layers.append(element('text', { x: String(x + 4), y: '18', class: 'layer-label' }, layerNames[layer]));
      layers.append(element('line', { x1: String(x - 8), y1: '28', x2: String(x - 8), y2: String(layout.bounds.height - 12), stroke: '#243039', 'stroke-dasharray': '2 5' }));
    } else {
      const y = 40 + (4 - layer) * layout.bounds.rankGap;
      layers.append(element('text', { x: '8', y: String(y + 14), class: 'layer-label' }, layerNames[layer]));
      layers.append(element('line', { x1: '150', y1: String(y + 20), x2: String(layout.bounds.width - 12), y2: String(y + 20), stroke: '#243039', 'stroke-dasharray': '2 5' }));
    }
  }
  svg.append(layers);
  const visibleNodes = renderSnapshot.nodes;
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const relevantEdges = layout.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const edgeGroup = element('g');
  for (const edge of relevantEdges) {
    const path = edge.points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
    edgeGroup.append(element('path', { d: path, class: `graph-edge ${edge.kind === 'reference' ? 'reference' : ''} ${edge.kind === 'aggregate' ? 'aggregate' : ''} ${isRelated(edge, focus) ? 'related' : ''}`, 'marker-end': `url(#${svg.id}-arrow)` }, `${edge.label || '关系'} · ${edge.id} · 来源 ${edge.from} → ${edge.to} · routes ${(edge.route_ids || []).join(', ') || '未知'}`));
  }
  svg.append(edgeGroup);
  const nodeGroup = element('g');
  for (const node of layout.nodes) {
    const aggregate = node.id === 'aggregate:evidence';
    const group = element('g', { class: `graph-node status-${safeState(node.state)} ${node.id === state.selectedId ? 'selected' : ''}`, tabindex: '0', role: 'button', 'aria-label': aggregate ? `展开聚合证据：${node.label}；共享来源 ${(node.aggregate_sources || []).join(', ')}` : nodeDescription(node), 'data-node-id': node.id });
    group.append(element('title', {}, aggregate ? `展开证据聚合；${node.label}；隐藏来源 ${(node.aggregate_sources || []).join(', ')}；共享路线 ${(node.route_ids || []).join(', ')}` : nodeDescription(node)));
    group.append(element('rect', { x: String(node.x), y: String(node.y), width: String(node.width), height: String(node.height), rx: '1' }));
    group.append(element('rect', { x: String(node.x + 10), y: String(node.y + (node.height - 9) / 2), width: '9', height: '9', class: 'state-mark' }));
    const baseline = node.height <= 32 ? 22 : 26;
    group.append(element('text', { x: String(node.x + 27), y: String(node.y + baseline), class: 'node-label' }, node.label || node.source_id));
    nodeGroup.append(group);
  }
  svg.append(nodeGroup);
  if (state.collapsed && svg.id === 'global-graph') {
    const summary = collapseEvidence(state.snapshot, { includeEvidence: false });
    svg.append(element('text', { x: String(layout.bounds.width - 12), y: '17', 'text-anchor': 'end', class: 'layer-label' }, `证据折叠 ${summary.hidden_node_count} 项 · 风险 ${summary.anomalies.length} 项 · routes ${summary.route_notes.length}`));
  }
}

function withCollapsedEvidence(snapshot) {
  const collapsed = collapseEvidence(snapshot, { includeEvidence: false });
  if (!collapsed.hidden_node_count) return snapshot;
  const hiddenIds = new Set(snapshot.nodes.filter((node) => node.layer === 2).map((node) => node.id));
  const bad = snapshot.nodes.filter((node) => hiddenIds.has(node.id));
  const aggregate = {
    id: 'aggregate:evidence', source_id: 'aggregate:evidence', adapter_instance: 'aggregate', entity_type: 'evidence-aggregate',
    label: `证据聚合 ${collapsed.hidden_node_count}项`,
    layer: 2, state: bad.some((node) => node.state === 'failed') ? 'failed' : bad.some((node) => node.state === 'pending') ? 'pending' : 'unknown',
    route_ids: collapsed.aggregate_nodes[0].shared_route_ids, aggregate_sources: bad.map((node) => node.source_id), task_ids: [], highest_proof: null, current_validity: null, updated_at: null,
  };
  const remap = (id) => hiddenIds.has(id) ? aggregate.id : id;
  const seen = new Set();
  const edges = [];
  for (const edge of snapshot.edges) {
    const from = remap(edge.from); const to = remap(edge.to);
    if (from === to) continue;
    const key = `${from}\0${to}\0${edge.kind}\0${(edge.route_ids || []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...edge, id: `${edge.id}:collapsed`, from, to, kind: hiddenIds.has(edge.from) || hiddenIds.has(edge.to) ? 'aggregate' : edge.kind, label: hiddenIds.has(edge.from) || hiddenIds.has(edge.to) ? '聚合证据依赖' : edge.label });
  }
  return { ...snapshot, nodes: [...snapshot.nodes.filter((node) => !hiddenIds.has(node.id)), aggregate], edges };
}

function renderRoutes(snapshot) {
  const root = $('#route-notes'); root.replaceChildren();
  for (const route of snapshot.routes || []) {
    const note = element('div', { class: 'route-note' });
    note.append(element('div', {}, [element('strong', {}, route.route_id), document.createTextNode(` · 跳板 ${route.jumphost_id || '未知'}`)]));
    note.append(element('div', {}, `入口 ${route.entry_ip || '未知'} → 出口 ${route.exit_ip || '未知'}`));
    note.append(element('div', {}, `租约 ${route.lease?.state || '未知'} · 到期 ${route.lease?.expires_at || '未知'}`));
    const verdict = route.egress?.verdict || 'unknown';
    const checkState = verdict === 'fail' ? 'failed' : verdict === 'pending' || (verdict === 'pass' && route.egress?.current === false) ? 'pending' : verdict === 'pass' && route.egress?.current === true ? 'verified' : 'unknown';
    const checkText = verdict === 'pass' && route.egress?.current === false ? '旧记录 · 待重新核验' : `出口核验 ${verdict} · 当前 ${route.egress?.current === true ? '是' : route.egress?.current === false ? '否' : '未知'}`;
    note.append(element('div', { class: `state-${checkState}` }, checkText));
    root.append(note);
  }
}

function renderMessages(snapshot) {
  const root = $('#messages'); root.replaceChildren();
  const messages = snapshot.conversation?.messages || [];
  $('#message-count').textContent = `${messages.length} 条 · ${snapshot.conversation?.status || 'unavailable'}`;
  if (!messages.length) root.append(element('p', { class: 'hint', style: 'padding:10px' }, `当前无对话内容 · ${snapshot.conversation?.status || 'unavailable'}`));
  for (const message of messages) {
    const row = element('article', { class: `message ${state.selectedId && message.node_ids?.includes(state.selectedId) ? 'related' : ''}`, 'data-message-id': message.id, title: `消息 ID ${message.id}` });
    row.append(element('div', { class: 'message-meta' }, `${message.role === 'assistant' ? 'DSH' : '用户'} · ${formatTime(message.created_at)}`));
    row.append(element('div', { class: 'message-text' }, message.text || ''));
    const refs = [...(message.node_ids || []), ...(message.route_ids || []), ...(message.task_ids || [])];
    if (refs.length) {
      const chips = element('div', { class: 'message-refs' });
      for (const id of message.node_ids || []) {
        const node = snapshot.nodes.find((item) => item.id === id);
        const label = node?.label || node?.source_id || `节点 · ${shortId(id)}`;
        chips.append(element('button', { class: 'ref-chip', type: 'button', title: `节点 ID ${id}${node ? ` · 来源 ${node.source_id}` : ''}`, 'data-node-ref': id, 'aria-label': `定位 ${label}，节点 ID ${id}` }, label));
      }
      for (const id of message.route_ids || []) {
        const route = (snapshot.routes || []).find((item) => item.route_id === id);
        chips.append(element('span', { class: 'ref-chip', title: `Route ID ${id}` }, `route · ${route?.jumphost_id || shortId(id)}`));
      }
      for (const id of message.task_ids || []) chips.append(element('span', { class: 'ref-chip', title: `Task ID ${id}` }, `task · ${shortId(id)}`));
      row.append(chips);
    }
    root.append(row);
  }
}

function renderDetail(snapshot) {
  const root = $('#node-detail'); root.replaceChildren();
  const node = snapshot.nodes.find((item) => item.id === state.selectedId);
  if (!node) { root.textContent = '选择对话引用或图中节点以查看完整详情。'; return; }
  const fields = [['节点', node.id], ['来源', node.source_id], ['适配器 / 类型', `${node.adapter_instance} / ${node.entity_type}`], ['状态', node.state], ['历史最高证明', node.highest_proof || '未知'], ['当前有效性', node.current_validity || '未知'], ['routes', (node.route_ids || []).join(', ') || '无'], ['tasks', (node.task_ids || []).join(', ') || '无'], ['更新时间', node.updated_at || '未知']];
  for (const [label, value] of fields) root.append(element('span', { class: 'detail-item' }, [document.createTextNode(`${label} `), element('strong', {}, value)]));
  if (node.aggregate_sources) root.append(element('span', { class: 'detail-item' }, [document.createTextNode('折叠来源 '), element('strong', {}, node.aggregate_sources.join(', '))]));
}

function renderSelectionTether(snapshot) {
  const root = $('#selection-tether');
  const node = snapshot.nodes.find((item) => item.id === state.selectedId);
  root.replaceChildren();
  if (!node) { root.textContent = '总览选择会同步到下方局部钻取。'; return; }
  root.append(element('span', { class: 'tether-global' }, `总览 · ${node.source_id} [${node.id}]`));
  root.append(element('span', { class: 'tether-link', 'aria-hidden': 'true' }, ' ───▶ '));
  root.append(element('span', { class: 'tether-local' }, `局部 · ${breadcrumb(snapshot, node.id)} · 祖先与后继闭包`));
}

function renderAnomalies(snapshot, focus) {
  const root = $('#focus-anomalies'); root.replaceChildren();
  const summary = collapseEvidence(snapshot, { includeEvidence: !state.collapsed });
  const items = summary.anomalies;
  const failed = items.filter((item) => item.state === 'failed').length;
  const pending = items.filter((item) => item.state === 'pending').length;
  const expired = items.filter((item) => item.state === 'expired').length;
  const warnings = snapshot.diagnostics?.warnings || [];
  root.append(element('span', { class: 'anomaly-chip state-failed' }, `失败 ${failed}`));
  root.append(element('span', { class: 'anomaly-chip state-pending' }, `待核验 ${pending}`));
  root.append(element('span', { class: 'anomaly-chip state-unknown' }, `租约过期 ${expired}`));
  if (state.collapsed) root.append(element('span', { class: 'anomaly-chip state-pending' }, `证据聚合 ${summary.hidden_node_count} 项 · 共享依赖保留`));
  if (focus) root.append(element('span', { class: 'anomaly-chip' }, `局部 ${focus.node_ids.length} 节点 / ${focus.edge_ids.length} 边 · ${focus.route_notes.length} 条 route 备注保留`));
  if (items.length || warnings.length) {
    const details = element('details', { class: 'diagnostic-details' });
    details.append(element('summary', {}, `完整诊断 ${items.length + warnings.length} 项`));
    for (const item of items) details.append(element('div', {}, `${item.state} · ${item.route_id || item.node_id || '未知'}`));
    for (const warning of warnings) details.append(element('div', {}, warning));
    root.append(details);
  }
}

function selectNode(id, scroll) {
  if (id === 'aggregate:evidence') { state.collapsed = false; $('#collapse-evidence').setAttribute('aria-pressed', 'false'); render(); return; }
  if (!state.snapshot?.nodes.some((node) => node.id === id)) return;
  state.selectedId = id; render();
  if (scroll) $('#focus-graph').focus({ preventScroll: true });
}

function searchExact() {
  const query = $('#map-search').value.trim();
  if (!query) { $('#search-result').textContent = '输入完整 ID 后定位'; return; }
  const result = findExactNode(state.snapshot, query);
  if (!result.candidates.length) { $('#search-result').textContent = `没有精确匹配：${query}`; return; }
  if (!result.node) { $('#search-result').textContent = `ID 有多个候选：${result.candidates.map((node) => `${node.adapter_instance}/${node.entity_type} · ${node.id}`).join('；')}。请用完整 node ID 定位。`; return; }
  const match = result.node;
  $('#search-result').textContent = `已定位 ${match.id}`;
  selectNode(match.id, true);
}

function renderTether() {
  for (const row of $('#messages').querySelectorAll('[data-message-id]')) {
    const message = state.snapshot.conversation?.messages?.find((item) => item.id === row.dataset.messageId);
    row.classList.toggle('related', Boolean(state.selectedId && message?.node_ids?.includes(state.selectedId)));
  }
}

function clearRenderedData() {
  $('#messages').replaceChildren();
  $('#route-notes').replaceChildren();
  $('#global-graph').replaceChildren();
  $('#focus-graph').replaceChildren();
  $('#focus-anomalies').replaceChildren();
  $('#node-detail').textContent = '正在读取当前范围…';
  $('#breadcrumb').textContent = '全局';
  $('#selection-tether').textContent = '总览选择会同步到下方局部钻取。';
  $('#message-count').textContent = '—';
  $('#search-result').textContent = '';
  $('#alert-summary').textContent = '';
}
function showError(error) { $('#global-error').hidden = false; $('#global-error').textContent = `数据读取失败：${error.message || error}`; $('#mode-badge').textContent = state.demo ? '演示数据 · 读取失败' : '真实数据 · 读取失败'; setStatus('错误 · 当前没有可显示的快照'); }
function setStatus(text) { $('#data-state').textContent = text; }
function statusText(snapshot) { return snapshot.mode === 'demo' ? '演示数据 · synthetic · 不代表真实战役' : `真实数据 · ${state.session ? `会话 ${state.session}` : state.sessionError ? '会话列表不可用 / 对话未接入' : state.sessions.length > 1 ? '未选择会话 / 对话未接入' : snapshot.conversation?.status || '对话未接入'} · 水位 ${snapshot.watermark?.fact_seq ?? '未知'} · 生成 ${snapshot.generated_at || '未知'}`; }
function breadcrumb(snapshot, id) { const node = snapshot.nodes.find((item) => item.id === id); return node ? `${layerNames[node.layer] || '节点'} / ${node.source_id}` : '全局'; }
function nodeDescription(node) { return `${node.label || node.source_id}；节点 ${node.id}；来源 ${node.source_id}；类型 ${node.entity_type}；状态 ${node.state}；历史最高证明 ${node.highest_proof || '未知'}；当前有效性 ${node.current_validity || '未知'}；路线 ${(node.route_ids || []).join(', ') || '无'}；任务 ${(node.task_ids || []).join(', ') || '无'}`; }
function isRelated(edge, focus) { return Boolean(focus && focus.edge_ids.includes(edge.id)); }
function safeState(stateName) { return ['verified', 'pending', 'failed'].includes(stateName) ? stateName : 'unknown'; }
function listFrom(value, keys) { if (Array.isArray(value)) return value; for (const key of keys) if (Array.isArray(value?.[key])) return value[key]; return []; }
function idOf(item, ...keys) { return keys.map((key) => item?.[key]).find((value) => typeof value === 'string') || ''; }
function fillSelect(select, items, idKey, labelKey, emptyLabel, includeAll = false) { select.replaceChildren(); if (includeAll) select.append(element('option', { value: '' }, emptyLabel)); if (!items.length) select.append(element('option', { value: '' }, emptyLabel)); for (const item of items) { const id = idOf(item, idKey, 'id'); if (id) select.append(element('option', { value: id }, item[labelKey] || id)); } }
function formatTime(value) { if (!value) return '时间未知'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function shortId(value) { return value.length <= 12 ? value : `…${value.slice(-10)}`; }
function element(tag, attributes = {}, children = null) { const node = document.createElementNS(tag === 'svg' || ['g','path','rect','text','line','marker','defs','title'].includes(tag) ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag); for (const [key, value] of Object.entries(attributes)) { if (value !== undefined && value !== null) node.setAttribute(key, String(value)); } if (Array.isArray(children)) node.append(...children); else if (children != null) node.textContent = String(children); return node; }

function zoomBy(factor) { const svg = $('#global-graph'); const view = parseViewBox(svg); if (!view) return; const nextWidth = Math.max(320, Math.min(6000, view.width / factor)); const ratio = nextWidth / view.width; setViewBox(svg, { x: view.x + view.width * (1 - ratio) / 2, y: view.y + view.height * (1 - ratio) / 2, width: nextWidth, height: view.height * ratio }); }
function fitMap() { for (const svg of [$('#global-graph'), $('#focus-graph')]) { if (svg.dataset.baseViewBox) svg.setAttribute('viewBox', svg.dataset.baseViewBox); } }
function enablePanZoom(svg) { let drag = null; svg.addEventListener('wheel', (event) => { event.preventDefault(); const view = parseViewBox(svg); if (!view) return; const ratio = event.deltaY < 0 ? 0.9 : 1.1; setViewBox(svg, { x: view.x + view.width * (1 - ratio) / 2, y: view.y + view.height * (1 - ratio) / 2, width: view.width * ratio, height: view.height * ratio }); }, { passive: false }); svg.addEventListener('pointerdown', (event) => { if (event.target.closest('[data-node-id]')) return; drag = { x: event.clientX, y: event.clientY, view: parseViewBox(svg) }; svg.setPointerCapture(event.pointerId); }); svg.addEventListener('pointermove', (event) => { if (!drag?.view) return; const rect = svg.getBoundingClientRect(); const scale = drag.view.width / rect.width; setViewBox(svg, { ...drag.view, x: drag.view.x - (event.clientX - drag.x) * scale, y: drag.view.y - (event.clientY - drag.y) * scale }); }); svg.addEventListener('pointerup', () => { drag = null; }); }
function parseViewBox(svg) { const numbers = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number); return numbers.length === 4 && numbers.every(Number.isFinite) ? { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] } : null; }
function setViewBox(svg, view) { svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`); }
