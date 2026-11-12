'use client';

import dynamic from 'next/dynamic';
import type { BoardroomData } from '../../../lib/types';

// Bryntum components need the DOM: render on the client only.
const TimeViews = dynamic(() => import('../../../components/time-views').then((m) => m.TimeViews), {
  ssr: false,
  loading: () => <div className="bryntum-host" />,
});

export function TimeViewsClient(props: {
  data: BoardroomData;
  payments: { id: string; name: string; constraintDate?: string }[];
}) {
  return <TimeViews {...props} />;
}
