"use client";

import { Check, Copy, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Dialog } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Field, Input, Select, Table, Td, Th } from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtDate, fmtRelative } from "@/lib/format";

interface Data {
  members: Array<{
    id: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    createdAt: string;
  }>;
  invites: Array<{ id: string; email: string; role: string; expiresAt: string; createdAt: string }>;
}

export function TeamClient({
  data,
  me,
  canManage,
  assignable,
  labels,
  matrix,
  permissions,
}: {
  data: Data;
  me: string;
  canManage: boolean;
  assignable: string[];
  labels: Record<string, string>;
  matrix: Array<{ role: string; label: string; permissions: string[] }>;
  permissions: string[];
}) {
  const { run, isBusy } = useAction();
  const [invite, setInvite] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={`Members (${data.members.length})`}
          actions={
            canManage ? (
              <Button size="sm" variant="primary" onClick={() => setInvite(true)}>
                <UserPlus className="h-3.5 w-3.5" /> Invite
              </Button>
            ) : null
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Member</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <Td>
                  <div className="font-medium">
                    {m.name} {m.userId === me ? <Badge>You</Badge> : null}
                  </div>
                  <div className="text-fg-muted text-[12px]">{m.email}</div>
                </Td>
                <Td>
                  {canManage && m.userId !== me && assignable.includes(m.role) ? (
                    <Select
                      aria-label={`Role for ${m.name}`}
                      className="h-8 w-[200px] text-[12.5px]"
                      defaultValue={m.role}
                      onChange={(e) =>
                        run(
                          `r${m.id}`,
                          () => api(`/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }),
                          { success: "Role updated" },
                        )
                      }
                    >
                      {assignable.map((r) => (
                        <option key={r} value={r}>
                          {labels[r]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge tone={m.role === "owner" ? "brand" : "neutral"}>{labels[m.role] ?? m.role}</Badge>
                  )}
                </Td>
                <Td className="text-fg-muted text-[12.5px]">{fmtDate(m.createdAt)}</Td>
                <Td className="text-right">
                  {canManage && m.userId !== me ? (
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      label="Remove"
                      title={`Remove ${m.name}?`}
                      effect="They lose access to this workspace immediately. Their audit history is kept."
                      confirmLabel="Remove"
                      onConfirm={() =>
                        run(`d${m.id}`, () => api(`/members/${m.id}`, { method: "DELETE" }), {
                          success: "Member removed",
                        }).then(() => undefined)
                      }
                    />
                  ) : null}
                </Td>
              </tr>
            ))}
            {data.invites.map((i) => (
              <tr key={i.id}>
                <Td>
                  <div className="font-medium">{i.email}</div>
                  <div className="text-fg-muted text-[12px]">
                    Invited {fmtRelative(i.createdAt)} · expires {fmtRelative(i.expiresAt)}
                  </div>
                </Td>
                <Td>
                  <Badge tone="warning">Pending · {labels[i.role] ?? i.role}</Badge>
                </Td>
                <Td />
                <Td className="text-right">
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        run(`i${i.id}`, () => api(`/invitations/${i.id}`, { method: "DELETE" }), {
                          success: "Invitation revoked",
                        })
                      }
                    >
                      Revoke
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader
          title="Role permissions"
          description="What each role can do. Tier 3 = public posts and messages; Tier 4 = spend and commerce."
        />
        <Table>
          <thead>
            <tr>
              <Th>Permission</Th>
              {matrix.map((m) => (
                <Th key={m.role} className="text-center">
                  {m.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissions.map((p) => (
              <tr key={p}>
                <Td className="font-mono text-[12px]">{p}</Td>
                {matrix.map((m) => (
                  <Td key={m.role} className="text-center">
                    {m.permissions.includes(p) ? (
                      <Check className="text-success-600 mx-auto h-3.5 w-3.5" aria-label="Allowed" />
                    ) : (
                      <span className="text-fg-subtle" aria-label="Not allowed">
                        —
                      </span>
                    )}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Dialog
        open={invite}
        onOpenChange={(o) => {
          setInvite(o);
          if (!o) setLink(null);
        }}
        title="Invite a teammate"
        description="Generates a single-use link valid for 7 days. Share it securely; email delivery requires an email provider (see docs)."
      >
        {link ? (
          <div className="space-y-3">
            <Input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => {
                  void navigator.clipboard.writeText(link);
                  toast.success("Link copied");
                }}
              >
                <Copy className="h-4 w-4" /> Copy link
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(
                "inv",
                () =>
                  api<{ inviteUrl: string }>("/members", {
                    body: { email: f.get("email"), role: f.get("role") },
                  }),
                { success: "Invitation created" },
              ).then((r) => r && setLink(r.inviteUrl));
            }}
            className="space-y-4"
          >
            <Field label="Email" htmlFor="inv-email">
              <Input id="inv-email" name="email" type="email" required />
            </Field>
            <Field label="Role" htmlFor="inv-role">
              <Select id="inv-role" name="role" defaultValue="creator">
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {labels[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={isBusy("inv")}>
                Create invite link
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
