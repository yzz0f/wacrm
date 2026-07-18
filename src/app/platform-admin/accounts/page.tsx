import { requirePlatformAdminPage } from '@/lib/platform-admin/require-page-admin';
import { AccountsListClient } from './accounts-list-client';

export default async function PlatformAdminAccountsPage() {
  await requirePlatformAdminPage();
  return <AccountsListClient />;
}
