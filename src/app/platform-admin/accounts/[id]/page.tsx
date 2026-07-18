import { requirePlatformAdminPage } from '@/lib/platform-admin/require-page-admin';
import { AccountDetailClient } from './account-detail-client';

export default async function PlatformAdminAccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformAdminPage();
  const { id } = await params;
  return <AccountDetailClient accountId={id} />;
}
