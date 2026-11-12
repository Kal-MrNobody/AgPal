'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AgCharts, AllEnterpriseModule, ModuleRegistry } from 'ag-charts-enterprise';
import { AgNoDataOverlay } from 'ag-studio-react';
import { boardroomStore } from '../store';
import { moneyFlows, type MoneyFlowLink } from './flows';

ModuleRegistry.registerModules([AllEnterpriseModule]);

/** Link colours by flow kind; every value is a CSS variable from the boardroom theme (app/globals.css). */
const KIND_COLOR: Record<MoneyFlowLink['kind'], string> = {
  funding: 'var(--flow-funding)',
  sale: 'var(--flow-sale)',
  allocation: 'var(--flow-allocation)',
  payout: 'var(--flow-payout)',
  internal: 'var(--flow-internal)',
  ai: 'var(--flow-ai)',
  fees: 'var(--flow-fees)',
  refund: 'var(--flow-refund)',
};

const css = (v: string): string => {
  const name = /^var\((--[\w-]+)\)$/.exec(v)?.[1];
  return name
    ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
    : v;
};

/** "Money flow": the signature boardroom widget (ADR-020). A Sankey of where every dollar came from and went. */
export default function MoneyFlow() {
  const data = useSyncExternalStore(
    boardroomStore.subscribe,
    boardroomStore.get,
    boardroomStore.get,
  );
  const links = useMemo(() => moneyFlows(data?.ledger ?? []), [data]);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current || links.length === 0) return;
    const chart = AgCharts.create({
      container: host.current,
      background: { visible: false },
      data: links,
      series: [
        {
          type: 'sankey',
          fromKey: 'from',
          toKey: 'to',
          sizeKey: 'size',
          sizeName: 'USD',
          fills: [css('var(--ink)')],
          strokes: [css('var(--ink)')],
          node: { minSpacing: 14, width: 14, strokeWidth: 0 },
          label: { color: css('var(--ink)'), fontWeight: 600 },
          link: {
            fillOpacity: 0.45,
            itemStyler: ({ datum }: { datum: MoneyFlowLink }) => ({
              fill: css(KIND_COLOR[datum.kind]),
            }),
          },
          tooltip: {
            renderer: ({ datum }: { datum: MoneyFlowLink }) => ({
              heading: `${datum.from} → ${datum.to}`,
              data: [{ label: datum.kind, value: `$${datum.size.toLocaleString('en-US')}` }],
            }),
          },
        },
      ],
    });
    return () => {
      chart.destroy();
    };
  }, [links]);

  if (links.length === 0) return <AgNoDataOverlay />;
  return <div ref={host} className="money-flow" style={{ width: '100%', height: '100%' }} />;
}
