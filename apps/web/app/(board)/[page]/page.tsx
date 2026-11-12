import { notFound } from 'next/navigation';
import { Approvals } from '../../../components/approvals';
import { Boardroom } from '../../../components/boardroom';
import { api } from '../../../lib/server';
import { PAGES, type BoardroomData, type PageId } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const meta = PAGES.find((p) => p.id === page);
  if (!meta) notFound();
  const data = await api<BoardroomData>('/api/boardroom');
  return (
    <>
      <header className="pagehead">
        <h1>{meta.title}</h1>
        <span className="muted">Company {data.companyId}</span>
      </header>
      {page === 'approvals' && (
        <Approvals items={data.approvals.filter((a) => a.status === 'pending')} />
      )}
      <Boardroom data={data} page={page as PageId} />
    </>
  );
}
