import { Component, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface SeriesPoint { label: string; value: number; secondary?: number; }
export interface CategorySlice { label: string; value: number; }

/**
 * Charts, drawn as inline SVG.
 *
 * No charting library. Three reasons, in order of importance:
 *
 *   1. **Themeability** — the marks reference the same CSS custom properties as
 *      the rest of the console, so the charts follow a theme switch for free.
 *      Most libraries need their palette re-specified in JavaScript.
 *   2. **Bundle size** — a general-purpose charting library is 150–400kB for
 *      three chart types.
 *   3. **Control** — axis labelling, "nice" tick rounding and accessible
 *      fallbacks are all things we want to decide, not inherit.
 *
 * Each chart also renders a visually-hidden data table, so the information is
 * available to a screen reader rather than being locked inside the graphic.
 */

/** Round an axis maximum up to a readable value (1, 2, 5 × 10ⁿ). */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

@Component({
  selector: 'pf-bar-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <figure class="chart">
      @if (!points().length) {
        <div class="empty">No data for this period</div>
      } @else {
        <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" preserveAspectRatio="none"
             class="chart-svg" role="img" [attr.aria-label]="ariaLabel">
          <!-- Gridlines first so marks paint over them. -->
          @for (line of gridLines(); track line.y) {
            <line [attr.x1]="padL" [attr.x2]="width - padR" [attr.y1]="line.y" [attr.y2]="line.y"
                  class="grid" />
            <text [attr.x]="padL - 8" [attr.y]="line.y + 3.5" class="axis-label" text-anchor="end">
              {{ line.label }}
            </text>
          }

          @for (bar of bars(); track bar.label) {
            <g>
              <!-- Stacked: succeeded sits on the baseline, failed above it, so
                   the total height reads as volume and the split reads as mix. -->
              <rect [attr.x]="bar.x" [attr.y]="bar.successY" [attr.width]="bar.w"
                    [attr.height]="bar.successH" rx="2" class="bar bar--success" />
              @if (bar.failH > 0) {
                <rect [attr.x]="bar.x" [attr.y]="bar.failY" [attr.width]="bar.w"
                      [attr.height]="bar.failH" rx="2" class="bar bar--fail" />
              }
              <title>{{ bar.label }}: {{ bar.total }} total, {{ bar.failed }} failed</title>
            </g>
          }

          <line [attr.x1]="padL" [attr.x2]="width - padR" [attr.y1]="height - padB"
                [attr.y2]="height - padB" class="axis" />

          @for (tick of xTicks(); track tick.x) {
            <text [attr.x]="tick.x" [attr.y]="height - padB + 16" class="axis-label"
                  text-anchor="middle">{{ tick.label }}</text>
          }
        </svg>

        <figcaption class="legend">
          <span class="legend-item"><i class="swatch swatch--success"></i>Succeeded</span>
          <span class="legend-item"><i class="swatch swatch--fail"></i>Failed</span>
        </figcaption>

        <table class="visually-hidden">
          <caption>{{ ariaLabel }}</caption>
          <thead><tr><th>Period</th><th>Succeeded</th><th>Failed</th></tr></thead>
          <tbody>
            @for (point of points(); track point.label) {
              <tr>
                <td>{{ point.label }}</td>
                <td>{{ point.value }}</td>
                <td>{{ point.secondary ?? 0 }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </figure>
  `,
  styles: [`
    .chart { margin: 0; }
    .chart-svg { width: 100%; height: 240px; overflow: visible; }
    .grid { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .axis { stroke: var(--border-strong); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .axis-label { fill: var(--text-dim); font-size: 10px; font-family: var(--mono); }
    .bar--success { fill: var(--c1); }
    .bar--fail { fill: var(--c6); }
    .bar { transition: opacity .12s; }
    .bar:hover { opacity: .75; }
    .legend { display: flex; gap: 16px; margin-top: 12px; font-size: 11px; color: var(--text-muted); }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
    .swatch--success { background: var(--c1); }
    .swatch--fail { background: var(--c6); }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; margin: -1px;
      padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
  `],
})
export class BarChartComponent {
  private readonly data = signal<SeriesPoint[]>([]);

  @Input({ required: true })
  set series(value: SeriesPoint[]) { this.data.set(value ?? []); }

  @Input() ariaLabel = 'Payment volume over time';

  readonly points = this.data.asReadonly();

  // A fixed viewBox with `preserveAspectRatio="none"` lets the chart stretch
  // to its container while the maths stays in simple, readable units.
  readonly width = 720;
  readonly height = 240;
  readonly padL = 44;
  readonly padR = 8;
  readonly padT = 12;
  readonly padB = 26;

  private readonly max = computed(() =>
    niceMax(Math.max(1, ...this.points().map((p) => p.value + (p.secondary ?? 0)))));

  private readonly plotH = this.height - this.padT - this.padB;

  readonly gridLines = computed(() => {
    const max = this.max();
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => {
      const value = (max / steps) * i;
      return {
        y: this.padT + this.plotH - (value / max) * this.plotH,
        label: value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)),
      };
    });
  });

  readonly bars = computed(() => {
    const points = this.points();
    const max = this.max();
    const plotW = this.width - this.padL - this.padR;
    const slot = plotW / Math.max(1, points.length);
    // Cap the bar width so a three-point series does not render as slabs.
    const barW = Math.max(2, Math.min(slot * 0.68, 46));

    return points.map((point, index) => {
      const failed = point.secondary ?? 0;
      const successH = (point.value / max) * this.plotH;
      const failH = (failed / max) * this.plotH;
      const baseline = this.padT + this.plotH;
      return {
        label: point.label,
        total: point.value + failed,
        failed,
        x: this.padL + slot * index + (slot - barW) / 2,
        w: barW,
        successY: baseline - successH,
        successH,
        failY: baseline - successH - failH,
        failH,
      };
    });
  });

  /** Thin the x labels so they never collide, whatever the bucket count. */
  readonly xTicks = computed(() => {
    const bars = this.bars();
    const stride = Math.max(1, Math.ceil(bars.length / 8));
    return bars
      .filter((_, index) => index % stride === 0)
      .map((bar) => ({ x: bar.x + bar.w / 2, label: bar.label }));
  });
}

@Component({
  selector: 'pf-donut',
  standalone: true,
  imports: [CommonModule],
  template: `
    <figure class="donut-wrap">
      @if (!total()) {
        <div class="empty">No data</div>
      } @else {
        <div class="donut-row">
          <svg viewBox="0 0 120 120" class="donut" role="img" [attr.aria-label]="ariaLabel">
            @for (arc of arcs(); track arc.label) {
              <circle
                cx="60" cy="60" [attr.r]="radius" fill="none"
                [attr.stroke]="arc.color" [attr.stroke-width]="14"
                [attr.stroke-dasharray]="arc.dash"
                [attr.stroke-dashoffset]="arc.offset"
                transform="rotate(-90 60 60)"
                stroke-linecap="butt">
                <title>{{ arc.label }}: {{ arc.value }} ({{ arc.percent }}%)</title>
              </circle>
            }
            <text x="60" y="57" text-anchor="middle" class="donut-total">{{ total() }}</text>
            <text x="60" y="72" text-anchor="middle" class="donut-caption">{{ caption }}</text>
          </svg>

          <ul class="donut-legend">
            @for (arc of arcs(); track arc.label) {
              <li>
                <i class="swatch" [style.background]="arc.color"></i>
                <span class="legend-label">{{ arc.label }}</span>
                <span class="legend-value num">{{ arc.value }}</span>
                <span class="legend-pct num dim">{{ arc.percent }}%</span>
              </li>
            }
          </ul>
        </div>
      }
    </figure>
  `,
  styles: [`
    .donut-wrap { margin: 0; }
    .donut-row { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .donut { width: 132px; height: 132px; flex-shrink: 0; }
    .donut-total { fill: var(--text); font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .donut-caption { fill: var(--text-dim); font-size: 8px; text-transform: uppercase; letter-spacing: .06em; }
    .donut-legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 170px; }
    .donut-legend li {
      display: flex; align-items: center; gap: 9px;
      padding: 5px 0; font-size: 12px;
    }
    .swatch { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
    .legend-label { flex: 1; color: var(--text-muted); text-transform: capitalize; }
    .legend-value { font-weight: 600; }
    .legend-pct { min-width: 42px; text-align: right; font-size: 11px; }
  `],
})
export class DonutChartComponent {
  private readonly data = signal<CategorySlice[]>([]);

  @Input({ required: true })
  set slices(value: CategorySlice[]) { this.data.set((value ?? []).filter((s) => s.value > 0)); }

  @Input() caption = 'total';
  @Input() ariaLabel = 'Distribution';
  /** Optional explicit colours; otherwise the shared chart series palette is used. */
  @Input() palette: string[] = [
    'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)',
  ];

  readonly radius = 50;
  private readonly circumference = 2 * Math.PI * 50;

  readonly total = computed(() => this.data().reduce((sum, slice) => sum + slice.value, 0));

  readonly arcs = computed(() => {
    const total = this.total();
    if (!total) return [];
    let consumed = 0;
    return this.data().map((slice, index) => {
      const fraction = slice.value / total;
      const length = fraction * this.circumference;
      const arc = {
        label: slice.label,
        value: slice.value,
        percent: Math.round(fraction * 1000) / 10,
        color: this.palette[index % this.palette.length],
        dash: `${length} ${this.circumference - length}`,
        // Negative offset advances the arc's start point around the circle.
        offset: -consumed,
      };
      consumed += length;
      return arc;
    });
  });
}
