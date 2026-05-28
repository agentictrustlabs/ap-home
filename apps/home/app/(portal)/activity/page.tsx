import { SectionShell } from '../../../src/components/portal/SectionShell';
import { HistoryIcon } from '../../../src/components/shared/Icons';

export default function ActivityPage() {
  return (
    <SectionShell
      title="Activity"
      status="soon"
      comingSoon={{
        icon: <HistoryIcon size={40} />,
        title: 'Activity log',
        body: 'A trustworthy record of what your portal and connected apps have done on your behalf.',
      }}
    />
  );
}
