/*
 * ATML parser — framework-agnostic port of the ATML/TestStand (IEEE 1636.1)
 * parsing logic. Turns a parsed XML Document into a step tree + result summary.
 */

export interface ArrayData {
  dims: number[];
  points: { pos: number[]; value: string }[];
}

export interface Limits {
  comparator: string | null;
  low: string | null;
  high: string | null;
  text: string;
}

export interface MeasurementItem {
  name: string;
  value: string;
  unit: string;
  type: string;
  limits: Limits | null;
  array: ArrayData | null;
}

export interface ParamItem {
  name: string;
  value: string;
  unit: string;
  array: ArrayData | null;
}

export interface DataItem {
  key: string;
  value: string;
}

export interface AtmlNode {
  el: Element;
  kind: string;
  name: string;
  id: string | null;
  start: string | null;
  end: string | null;
  outcome: string | null;
  outcomeQualifier: string | null;
  stepType: string | null;
  time: number | null;
  children: AtmlNode[];
  measurements: MeasurementItem[];
  inputs: ParamItem[];
  outputs: ParamItem[];
  details: string[];
  data: DataItem[];
}

export interface AtmlResultSummary {
  programName: string;
  rawName: string;
  operator: string | null;
  serialNumber: string | null;
  systemId: string | null;
  partNumber: string | null;
  outcome: string | null;
  start: string | null;
  end: string | null;
}

export interface ParsedAtml {
  summary: AtmlResultSummary;
  root: AtmlNode;
}

const ATML_NS_HINTS = ['ieee-1636', 'ieee-1671', 'atmltestresults'];
const STEP_LOCALS = ['test', 'sessionaction', 'testgroup'];
const MEAS_TYPE_NAMES = new Set(['numeric', 'string', 'boolean', 'number', 'measurement']);

/* ---------- namespace-agnostic traversal ---------- */
function childrenByLocal(node: Element, ...locals: string[]): Element[] {
  const set = locals.map((l) => l.toLowerCase());
  return Array.from(node.children).filter((c) => set.includes((c.localName || '').toLowerCase()));
}
function firstChildByLocal(node: Element, local: string): Element | null {
  return childrenByLocal(node, local)[0] ?? null;
}
function firstByLocal(node: Element, local: string): Element | null {
  const l = local.toLowerCase();
  const walk = (n: Element): Element | null => {
    for (const c of Array.from(n.children)) {
      if ((c.localName || '').toLowerCase() === l) {
        return c;
      }
      const found = walk(c);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(node);
}
function attr(node: Element | null, name: string): string | null {
  if (!node) {
    return null;
  }
  if (node.hasAttribute?.(name)) {
    return node.getAttribute(name);
  }
  if (node.attributes) {
    for (const a of Array.from(node.attributes)) {
      const local = a.localName || a.name;
      if (local && local.toLowerCase() === name.toLowerCase()) {
        return a.value;
      }
    }
  }
  return null;
}
function textOf(node: Element | null): string {
  return node ? (node.textContent || '').trim() : '';
}

/* ---------- detection ---------- */
export function isAtml(doc: Document): boolean {
  const root = doc.documentElement;
  if (!root) {
    return false;
  }
  const ln = (root.localName || '').toLowerCase();
  if (ln === 'testresultscollection' || ln === 'testresults') {
    return true;
  }
  const ns = (root.namespaceURI || '').toLowerCase();
  if (ATML_NS_HINTS.some((h) => ns.includes(h))) {
    return true;
  }
  return !!firstByLocal(root, 'ResultSet');
}

/* ---------- names ---------- */
export function prettySequenceName(name: string | null): string {
  if (!name) {
    return 'Test Results';
  }
  const hashIdx = name.indexOf('#');
  const beforeHash = hashIdx >= 0 ? name.slice(0, hashIdx) : name;
  const base = (beforeHash.split(/[\\/]/).pop() || '').trim();
  if (base) {
    return base;
  }
  const after = hashIdx >= 0 ? name.slice(hashIdx + 1) : name;
  const cleaned = after.replace(/\bMainSequence\b/gi, '').replace(/\bCallback\b/gi, '').trim();
  return cleaned || after.trim() || 'Test Results';
}
function resultSetStepName(rs: Element): string {
  const raw = attr(rs, 'name') || '';
  const seq = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : (raw || 'MainSequence');
  return /callback/i.test(seq) ? seq : `${seq} Callback`;
}

/* ---------- tree ---------- */
function buildResultSetRootNode(resultSet: Element): AtmlNode {
  const root = buildNode(resultSet);
  root.name = resultSetStepName(resultSet);
  return root;
}
function buildStepTree(parent: Element): AtmlNode[] {
  const out: AtmlNode[] = [];
  for (const child of Array.from(parent.children)) {
    const ln = (child.localName || '').toLowerCase();
    if (!STEP_LOCALS.includes(ln)) {
      continue;
    }
    out.push(buildNode(child));
  }
  return out;
}
function buildNode(child: Element): AtmlNode {
  const ln = child.localName || '';
  const params = extractParameters(child);
  const results = extractResults(child);
  const oEl = firstChildByLocal(child, 'Outcome') || firstChildByLocal(child, 'ActionOutcome');
  const details = results.details.slice();
  const data: DataItem[] = [];
  for (const d of extractData(child)) {
    if ((d.key || '').trim().toLowerCase() === 'reporttext') {
      if (d.value != null && String(d.value) !== '') {
        details.push(d.value);
      }
    } else {
      data.push(d);
    }
  }
  return {
    el: child,
    kind: ln,
    name: attr(child, 'callerName') || attr(child, 'name') || ln,
    id: attr(child, 'ID'),
    start: attr(child, 'startDateTime'),
    end: attr(child, 'endDateTime'),
    outcome: oEl ? attr(oEl, 'value') : null,
    outcomeQualifier: oEl ? attr(oEl, 'qualifier') : null,
    stepType: stepType(child),
    time: stepTime(child),
    children: buildStepTree(child),
    measurements: results.measurements,
    inputs: params.inputs,
    outputs: [...params.outputs, ...results.outputs],
    details,
    data,
  };
}

function outcomeOf(node: Element): string | null {
  const o = firstChildByLocal(node, 'Outcome') || firstChildByLocal(node, 'ActionOutcome');
  return o ? attr(o, 'value') : null;
}
function stepType(node: Element): string | null {
  const st = firstByLocal(node, 'StepType');
  return st ? textOf(st) : null;
}
function stepTime(node: Element): number | null {
  const ext = firstChildByLocal(node, 'Extension');
  const t = ext ? firstByLocal(ext, 'TotalTime') : null;
  const v = t ? attr(t, 'value') : null;
  if (v != null && !isNaN(Number(v))) {
    return Number(v);
  }
  const start = attr(node, 'startDateTime');
  const end = attr(node, 'endDateTime');
  if (start && end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!isNaN(s) && !isNaN(e) && e >= s) {
      return (e - s) / 1000;
    }
  }
  return null;
}

/* ---------- results / measurements ---------- */
function buildResultItem(r: Element): MeasurementItem {
  const name = attr(r, 'name') || 'Measurement';
  const dataEl = firstChildByLocal(r, 'TestData');
  const datum = dataEl ? firstChildByLocal(dataEl, 'Datum') : null;
  const arrEl = dataEl ? firstChildByLocal(dataEl, 'IndexedArray') : null;
  const array = arrEl ? parseIndexedArray(arrEl) : null;
  const value = datum ? datumValue(datum) : '';
  const unit = datum
    ? attr(datum, 'nonStandardUnit') || attr(datum, 'unit') || ''
    : arrEl
      ? attr(arrEl, 'nonStandardUnit') || attr(arrEl, 'unit') || ''
      : '';
  const type = datum
    ? shortType(attr(datum, 'type') || datumXsiType(datum))
    : arrEl
      ? shortType(attr(arrEl, 'type'))
      : '';
  const limits = extractLimits(r);
  return { name, value, unit, type, limits, array };
}
function isMeasurementResult(r: Element): boolean {
  if (firstChildByLocal(r, 'TestLimits')) {
    return true;
  }
  const name = (attr(r, 'name') || '').trim().toLowerCase();
  return MEAS_TYPE_NAMES.has(name);
}
function extractResults(node: Element): {
  measurements: MeasurementItem[];
  outputs: ParamItem[];
  details: string[];
} {
  const results = childrenByLocal(node, 'TestResult');
  const measurements: MeasurementItem[] = [];
  const outputs: ParamItem[] = [];
  const details: string[] = [];
  for (const r of results) {
    const item = buildResultItem(r);
    if ((item.name || '').trim().toLowerCase() === 'reporttext') {
      if (item.value != null && String(item.value) !== '') {
        details.push(item.value);
      }
    } else if (isMeasurementResult(r)) {
      measurements.push(item);
    } else {
      outputs.push({ name: item.name, value: item.value, unit: item.unit, array: item.array });
    }
  }
  return { measurements, outputs, details };
}

function parseIndexedArray(arrEl: Element): ArrayData {
  const dimsMatch = (attr(arrEl, 'dimensions') || '').match(/\d+/g);
  const points = childrenByLocal(arrEl, 'Element').map((e) => ({
    pos: ((attr(e, 'position') || '').match(/-?\d+/g) || []).map(Number),
    value: attr(e, 'value') != null ? (attr(e, 'value') as string) : textOf(e),
  }));
  return { dims: dimsMatch ? dimsMatch.map(Number) : [points.length], points };
}

function extractParameters(node: Element): { inputs: ParamItem[]; outputs: ParamItem[] } {
  const inputs: ParamItem[] = [];
  const outputs: ParamItem[] = [];
  const params = firstChildByLocal(node, 'Parameters');
  if (!params) {
    return { inputs, outputs };
  }
  for (const p of childrenByLocal(params, 'Parameter')) {
    const name = attr(p, 'name') || 'Parameter';
    const dataEl = firstChildByLocal(p, 'Data');
    const datum = dataEl ? firstChildByLocal(dataEl, 'Datum') : null;
    const arrEl = dataEl ? firstChildByLocal(dataEl, 'IndexedArray') : null;
    const array = arrEl ? parseIndexedArray(arrEl) : null;
    const value = datum ? datumValue(datum) : attr(p, 'value') || '';
    const unit = datum
      ? attr(datum, 'nonStandardUnit') || attr(datum, 'unit') || ''
      : arrEl
        ? attr(arrEl, 'nonStandardUnit') || attr(arrEl, 'unit') || ''
        : '';
    const dir = (attr(p, 'direction') || '').toLowerCase();
    const item: ParamItem = { name, value, unit, array };
    if (dir.startsWith('out')) {
      outputs.push(item);
    } else if (dir === 'inout' || dir === 'in-out') {
      inputs.push(item);
      outputs.push(item);
    } else {
      inputs.push(item);
    }
  }
  return { inputs, outputs };
}

function datumXsiType(datum: Element | null): string | null {
  return attr(datum, 'type');
}
function datumValue(datum: Element | null): string {
  const v = attr(datum, 'value');
  if (v != null) {
    return v;
  }
  const valEl = datum ? firstChildByLocal(datum, 'Value') : null;
  return valEl ? textOf(valEl) : '';
}
function shortType(t: string | null): string {
  if (!t) {
    return '';
  }
  return String(t).replace(/^.*?:/, '').replace(/^TS_/, '');
}

function extractLimits(testResult: Element): Limits | null {
  const tl = firstChildByLocal(testResult, 'TestLimits');
  if (!tl) {
    return null;
  }
  const limits = firstChildByLocal(tl, 'Limits');
  if (!limits) {
    return null;
  }
  let comparator: string | null = null;
  let low: string | null = null;
  let high: string | null = null;
  const single = firstChildByLocal(limits, 'SingleLimit');
  const pair = firstChildByLocal(limits, 'LimitPair');
  if (single) {
    comparator = attr(single, 'comparator');
    const v = datumValue(firstChildByLocal(single, 'Datum'));
    if (/^G/.test(comparator || '')) {
      low = v;
    } else if (/^L/.test(comparator || '')) {
      high = v;
    } else {
      low = v;
    }
  } else if (pair) {
    const comps: string[] = [];
    for (const lim of childrenByLocal(pair, 'Limit')) {
      const c = attr(lim, 'comparator');
      comps.push(c || '');
      const v = datumValue(firstChildByLocal(lim, 'Datum'));
      if (/^G/.test(c || '')) {
        low = v;
      } else if (/^L/.test(c || '')) {
        high = v;
      }
    }
    comparator = comps.join('');
  }
  const raw = firstByLocal(limits, 'RawLimits');
  if (raw) {
    const lo = firstChildByLocal(raw, 'Low');
    const hi = firstChildByLocal(raw, 'High');
    if (lo && attr(lo, 'value') != null) {
      low = attr(lo, 'value');
    }
    if (hi && attr(hi, 'value') != null) {
      high = attr(hi, 'value');
    }
  }
  const exp = firstByLocal(limits, 'Expected');
  if (!single && !pair && exp) {
    comparator = 'EQ';
    low = high = datumValue(firstChildByLocal(exp, 'Datum') || exp);
  }
  let text = '';
  if (low != null && high != null) {
    text = `${low} … ${high}`;
  } else if (low != null) {
    text = `${cmpSymbol(comparator)} ${low}`;
  } else if (high != null) {
    text = `${cmpSymbol(comparator)} ${high}`;
  }
  return { comparator, low, high, text };
}
function cmpSymbol(c: string | null): string {
  const map: Record<string, string> = {
    GT: '>', GE: '≥', LT: '<', LE: '≤', EQ: '=', NE: '≠', GELE: 'in', GTLT: 'in', LTGT: 'out',
  };
  return (c && map[c]) || c || '';
}

function extractData(node: Element): DataItem[] {
  const dataEl = firstChildByLocal(node, 'Data');
  if (!dataEl) {
    return [];
  }
  const coll = firstByLocal(dataEl, 'Collection');
  if (!coll) {
    return [];
  }
  return childrenByLocal(coll, 'Item')
    .map((it) => {
      const datum = firstChildByLocal(it, 'Datum');
      return { key: attr(it, 'name') || '(item)', value: datum ? datumValue(datum) : '' };
    })
    .filter((d) => d.value !== '' && d.value != null);
}

function extractPartNumber(results: Element): string | null {
  const idn = firstByLocal(results, 'IdentificationNumber');
  return (idn ? attr(idn, 'number') : null) || null;
}

/* ---------- entry point ---------- */
export function parseAtml(doc: Document): ParsedAtml | null {
  const results = firstByLocal(doc.documentElement, 'TestResults') || doc.documentElement;
  const resultSet = firstByLocal(results, 'ResultSet');
  if (!resultSet) {
    return null;
  }
  const rawName = attr(resultSet, 'name') || 'Test Results';
  const summary: AtmlResultSummary = {
    programName: prettySequenceName(rawName),
    rawName,
    operator: attr(firstByLocal(results, 'SystemOperator'), 'name'),
    serialNumber: textOf(firstByLocal(firstChildByLocal(results, 'UUT') || results, 'SerialNumber')) || null,
    systemId:
      textOf(firstByLocal(firstChildByLocal(results, 'TestStation') || results, 'SerialNumber')) || null,
    partNumber: extractPartNumber(results),
    outcome: outcomeOf(resultSet),
    start: attr(resultSet, 'startDateTime'),
    end: attr(resultSet, 'endDateTime'),
  };
  return { summary, root: buildResultSetRootNode(resultSet) };
}

/* ---------- display helpers ---------- */
export function outcomeClass(o: string | null): string {
  const v = (o || '').toLowerCase();
  if (v === 'passed') return 'passed';
  if (v === 'failed') return 'failed';
  if (v === 'done') return 'done';
  if (v === 'error' || v === 'errored') return 'error';
  if (v === 'terminated') return 'terminated';
  if (v === 'skipped') return 'skipped';
  return 'unknown';
}
export function formatSeconds(s: number | null): string {
  if (s == null || isNaN(s)) {
    return '';
  }
  if (s < 1) {
    return `${(s * 1000).toFixed(0)} ms`;
  }
  if (s < 60) {
    return `${s.toFixed(2)} s`;
  }
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0);
  return `${m}m ${rem}s`;
}
export function countStats(
  node: AtmlNode,
  stats = { passed: 0, failed: 0, other: 0, total: 0 },
): { passed: number; failed: number; other: number; total: number } {
  stats.total++;
  const o = (node.outcome || '').toLowerCase();
  if (o === 'passed') {
    stats.passed++;
  } else if (o === 'failed') {
    stats.failed++;
  } else {
    stats.other++;
  }
  for (const c of node.children) {
    countStats(c, stats);
  }
  return stats;
}
