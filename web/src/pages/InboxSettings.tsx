import { useState } from 'react';
import { api, canManage, type PageProps } from '../api';
import { useResource, Resource, Field, Confirm, useTask } from '../components/Management';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export type InboxData = { address: string | null; support_address: string; auto_run: boolean; auto_send: boolean; received: boolean;
  confirmations: { id: string; body: string; confirmation_link: string | null; confirmation_code: string | null }[]; skipped: { at: string; reason: string }[] };
export function InboxSettings({ state }: PageProps) {
  const settings = useResource<InboxData>('/api/inbox/settings');
  const { busy, run } = useTask();
  const [copied, setCopied] = useState(false);
  return <Resource query={settings}>{settings.data && <Card className="max-w-2xl p-6">
    <h2>Inbox</h2>
    {settings.data.address ? <>
      <p>Forward your support email to:</p><code className="break-all">{settings.data.address}</code>
      <Button variant="outline" onClick={() => void run(async () => { await navigator.clipboard.writeText(settings.data!.address!); setCopied(true); })}>{copied ? 'Copied' : 'Copy'}</Button>
      {canManage(state) && <Confirm title="Create a new forwarding address?" description="The old address will stop accepting messages. Update your mailbox forwarding rule afterwards." label="New address" done="Address rotated" onConfirm={async () => { await api('/api/inbox/rotate', 'POST', { confirm: true }); await settings.refetch(); }}>New address</Confirm>}
      <ol className="list-decimal pl-5 space-y-2 text-sm"><li>Gmail: Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address. Confirm using the message in your Floorwalker inbox, then enable forwarding.</li><li>Outlook: Settings → Mail → Forwarding. Enable forwarding to this address and keep a copy. Check your Floorwalker inbox for a confirmation.</li><li>Shopify: forward the mailbox used as your store’s customer support email here. Keep your verified sender email in Shopify’s Notifications settings.</li></ol>
    </> : <p>Inbound email isn't set up on this server.</p>}
    <form key={JSON.stringify(settings.data)} className="space-y-4" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => { await api('/api/inbox/settings', 'PATCH', { support_address: f.get('support'), auto_run: f.has('auto_run'), auto_send: f.has('auto_send') }); await settings.refetch(); }, 'Inbox settings saved'); }}>
      <fieldset disabled={!canManage(state) || busy} className="space-y-4">
        <Field label="Support address for replies" hint="Required before sending. Customers’ replies go to this mailbox."><Input type="email" name="support" defaultValue={settings.data.support_address} /></Field>
        <label className="flex gap-2"><input type="checkbox" name="auto_run" defaultChecked={settings.data.auto_run} />Let the Support agent handle new emails on its own</label>
        <label className="flex gap-2"><input type="checkbox" name="auto_send" defaultChecked={settings.data.auto_send} />Send the agent's replies on their own</label>
        <p className="text-sm">Replies involving held or blocked money moves always wait for you.</p><Button>Save inbox settings</Button>
      </fieldset>
    </form>
  </Card>}</Resource>;
}
