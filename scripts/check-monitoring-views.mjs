import assert from 'node:assert/strict';
import { autoDisplay, lineSVG, renderChart, seriesOf } from '../web/views.js';

const check = (condition, message) => assert.ok(condition, message);

// Semantic kinds take precedence, while ordinary scalar readings stay compact composites.
assert.equal(autoDisplay({ value: 9, metric: { kind: 'scalar' } }), 'composite');
assert.equal(autoDisplay({ value: 9, metric: { kind: 'capacity', denominator: 20 } }), 'capacity');
assert.equal(autoDisplay({ value: 9, metric: { kind: 'rate' } }), 'line');
assert.equal(autoDisplay({ value: 9, metric: { kind: 'counter' } }), 'composite');
assert.equal(autoDisplay({ value: 9, metric: { kind: 'breakdown' } }), 'breakdown');
assert.equal(autoDisplay({ data: { columns: [{ key: 'name' }], rows: [{ name: 'worker' }] }, metric: { kind: 'table' } }), 'table');
assert.equal(autoDisplay({ data: { columns: [{ key: 'name' }], rows: [{ name: 'worker' }] }, metric: { kind: 'grid' } }), 'grid');
assert.equal(autoDisplay({ pipeline: { stages: [{ key: 'fetch' }] } }), 'pipeline');
assert.equal(autoDisplay({ value: 2, history: [{ t: 1, v: 1 }, { t: 2, v: 2 }] }), 'composite');
assert.equal(autoDisplay({ value: 'ready', metric: { kind: 'scalar' } }), 'composite');

// Target lines and events appear on time charts; all user strings remain escaped.
const line = lineSVG({
  id: 'line',
  value: 3,
  unit: 'req/s',
  history: [{ t: 1_000, v: 1 }, { t: 2_000, v: 2 }, { t: 3_000, v: 3 }],
  plot: {
    targets: [{ value: 2.5, label: '<target>' }],
    events: [{ id: 'deploy', time: 2_000, text: '<script>alert(1)</script>' }],
  },
}, 320, 100, { targets: [{ value: 2.5, label: '<target>' }], events: [{ id: 'deploy', time: 2_000, text: '<script>alert(1)</script>' }] });
check(line.includes('class="target"'), 'target line is rendered');
check(line.includes('class="event"'), 'event marker is rendered');
check(line.includes('&lt;target&gt;'), 'target label is escaped');
check(line.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'event label is escaped');
check(!line.includes('<script>'), 'event text cannot inject markup');

// Nulls stay absent from the public numeric series and split line paths instead of joining readings.
const gaps = { id: 'gaps', history: [{ t: 1_000, v: 1 }, { t: 2_000, v: null }, { t: 3_000, v: 3 }] };
assert.deepEqual(seriesOf(gaps).pts.map((point) => point.v), [1, 3]);
const gapLine = lineSVG(gaps, 320, 100, {});
assert.equal((gapLine.match(/<path d="M/g) || []).length, 2, 'unavailable reading leaves two line segments');

// Compatible units can share a chart; incompatible series stay out of the axis.
const multi = lineSVG({
  id: 'multi',
  metric: { unit: 'ms' },
  history: [{ t: 1_000, v: 5 }, { t: 2_000, v: 6 }],
  plotSeries: [
    { label: 'latency', unit: 'ms', history: [{ t: 1_000, v: 5 }, { t: 2_000, v: 6 }] },
    { label: 'queue', unit: 'ms', history: [{ t: 1_000, v: 2 }, { t: 2_000, v: 3 }] },
    { label: '<other>', unit: 'bytes', history: [{ t: 1_000, v: 50 }, { t: 2_000, v: 60 }] },
  ],
}, 320, 100, {});
check(multi.includes('latency') && multi.includes('queue'), 'compatible series are drawn');
check(!multi.includes('&lt;other&gt;'), 'incompatible series are omitted');

// Table and grid preserve null as missing while keeping a real zero visible.
const dataItem = {
  id: 'table',
  metric: { kind: 'table' },
  data: {
    columns: [{ key: 'missing', label: '<missing>' }, { key: 'zero', label: 'zero' }],
    rows: [{ missing: null, zero: 0, source: '<source>', state: 'ok' }],
  },
};
const table = renderChart('table', dataItem, { reserve: 0 });
check(table.includes('—') && table.includes('>0</td>'), 'table distinguishes missing from zero');
check(table.includes('&lt;missing&gt;') && table.includes('&lt;source&gt;'), 'table headers and metadata are escaped');
check(!table.includes('<source>'), 'table values cannot inject markup');
const grid = renderChart('grid', { ...dataItem, id: 'grid' }, { reserve: 0 });
check(grid.includes('role="grid"') && grid.includes('—') && grid.includes('>0</td>'), 'grid renders a semantic matrix with missing and zero cells');

// Pipeline labels, source details, and rendered readings are all escaped and visible.
const pipeline = renderChart('pipeline', {
  id: 'pipe',
  pipelineView: {
    message: '<pipeline status>',
    stages: [{
      key: 'scan', label: '<scan>', candidate: true,
      throughput: { value: 12, unit: 'jobs/s', source: '<node>', state: 'ok', ageSeconds: 4 },
      queued: { value: 0 }, inFlight: null, oldestAge: { value: null, unit: 's' },
      retries: { value: 2 }, rejected: { value: 1, stale: true },
    }],
  },
}, { reserve: 0 });
check(pipeline.includes('&lt;scan&gt;') && pipeline.includes('&lt;pipeline status&gt;'), 'pipeline text is escaped');
check(!pipeline.includes('<scan>') && !pipeline.includes('<node>'), 'pipeline labels and tooltips cannot inject markup');
check(pipeline.includes('>12 <span') && pipeline.includes('>0</td>') && pipeline.includes('—'), 'pipeline displays values, zero, and missing metrics');
check(pipeline.includes('stale'), 'pipeline exposes stale metric state');

const hostileBreakdown = renderChart('breakdown', {
  id: 'breakdown',
  metric: { kind: 'breakdown' },
  meta: { categories: [{ label: '<img src=x onerror=alert(1)>', value: 1 }, { label: 'safe', value: 2 }] },
}, { reserve: 0 });
check(hostileBreakdown.includes('&lt;img') && !hostileBreakdown.includes('<img'), 'breakdown labels are escaped');

console.log('PASS: semantic view selection, target/event overlays, null gaps, compatible series, null/zero tables and grids, pipeline metrics, and escaped user strings');
