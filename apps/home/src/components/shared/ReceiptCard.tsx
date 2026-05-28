// Celebratory confirmation of a completed milestone (sage). role=status so screen readers
// announce it. Optional detail + block-explorer link.
import { CheckCircleIcon, ExternalLinkIcon } from './Icons';

export function ReceiptCard({
  title,
  body,
  detail,
  explorerUrl,
}: {
  title: string;
  body?: string;
  detail?: string;
  explorerUrl?: string;
}) {
  return (
    <div className="receipt-card" role="status">
      <span className="receipt-card-icon" aria-hidden="true"><CheckCircleIcon size={22} /></span>
      <div className="receipt-card-body">
        <div className="receipt-card-title">{title}</div>
        {body && <div className="receipt-card-sub">{body}</div>}
        {detail && (
          <div className="receipt-card-detail">
            <span>{detail}</span>
            {explorerUrl && (
              <a href={explorerUrl} target="_blank" rel="noreferrer" aria-label="View on block explorer">
                <ExternalLinkIcon size={14} />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
