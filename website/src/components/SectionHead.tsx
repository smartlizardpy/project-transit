import type { ReactNode } from 'react';

/** A section's heading, optionally with its lead paragraph beside it on wide screens. */
export function SectionHead({ id, title, lead, split = false }: { id: string; title: ReactNode; lead?: ReactNode; split?: boolean }) {
  return (
    <div className={`sec-head${split ? ' sec-head--split' : ''}`}>
      <h2 className="h2" id={`${id}-title`}>
        {title}
      </h2>
      {lead && <p className="lead">{lead}</p>}
    </div>
  );
}
