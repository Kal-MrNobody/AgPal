'use client';

import { use } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { AgIncompleteDataMappingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import type { EnvelopeGaugeDef } from '../registry';

const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Envelope gauge: one bar per department showing spent, held and available out of what was allocated. */
export default function EnvelopeGauge({
  widgetApi,
  dataMapping,
}: AgWidgetParams<EnvelopeGaugeDef>) {
  const dept = dataMapping.department?.at(0);
  const spent = dataMapping.spent?.at(0);
  const held = dataMapping.held?.at(0);
  const available = dataMapping.available?.at(0);
  if (!dept || !spent || !held || !available) return <AgIncompleteDataMappingOverlay />;
  const response = use(widgetApi.getData({ fields: [dept, spent, held, available] }));
  const rows = response.results.rows;
  if (rows.length === 0) return <AgNoDataOverlay />;
  return (
    <div className="gauge">
      {rows.map((r) => {
        const s = Number(r[spent.key] ?? 0);
        const h = Number(r[held.key] ?? 0);
        const a = Number(r[available.key] ?? 0);
        const total = Math.max(s + h + a, 0.01);
        return (
          <div key={String(r[dept.key])} className="gauge-row">
            <div className="gauge-label">
              <strong>{String(r[dept.key])}</strong>
              <span>{usd(a)} available</span>
            </div>
            <div
              className="gauge-bar"
              role="img"
              aria-label={`spent ${usd(s)}, held ${usd(h)}, available ${usd(a)}`}
            >
              <span className="g-spent" style={{ width: `${(s / total) * 100}%` }} />
              <span className="g-held" style={{ width: `${(h / total) * 100}%` }} />
              <span className="g-avail" style={{ width: `${(a / total) * 100}%` }} />
            </div>
            <div className="gauge-legend">
              spent {usd(s)} · held {usd(h)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
