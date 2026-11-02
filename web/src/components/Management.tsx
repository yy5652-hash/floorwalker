import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Loader2 } from "lucide-react";
import { api, errorMessage } from "../api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function useTask() {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async (work: () => Promise<unknown>, message?: string) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    try {
      await work();
      if (message) toast.success(message);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}
export function useResource<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<T>(path, "GET", undefined, signal),
    enabled,
  });
}
export function Resource({
  query,
  children,
}: {
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
  children: ReactNode;
}) {
  if (query.isPending)
    return (
      <div className="space-y-3" role="status" aria-label="Loading">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (query.error)
    return (
      <Card className="p-6">
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
        <Button variant="outline" onClick={() => query.refetch()}>
          Try again
        </Button>
      </Card>
    );
  return <>{children}</>;
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
export function Modal({
  title,
  description,
  open,
  onClose,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Confirm({
  title,
  description,
  onConfirm,
  children,
  disabled,
  reason,
  label = "Confirm",
  done,
  closeOnError = false,
  danger = true,
}: {
  title: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  children: ReactNode;
  disabled?: boolean;
  // Why the button is disabled, shown as its tooltip.
  reason?: string;
  label?: string;
  // Shown as a notice once the action has gone through.
  done?: string;
  // Close this dialog when the action fails, so an explanation on the page behind it is not hidden.
  closeOnError?: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { busy, run } = useTask();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        title={disabled ? reason : undefined}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      <Modal
        title={title}
        description={description}
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
      >
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Keep as is
          </Button>
          <Button
            variant={danger ? "destructive" : "default"}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await onConfirm();
                setOpen(false);
              }, done).then((ok) => {
                if (!ok && closeOnError) setOpen(false);
              })
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            {label}
          </Button>
        </DialogFooter>
      </Modal>
    </>
  );
}
// Copies text, falling back to a hidden textarea where the clipboard API is blocked (plain http, some embedded views).
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Copy unavailable");
  }
}
export function Code({
  text,
  label = "Copy code",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <div className="relative min-w-0 rounded-lg border bg-muted/40">
      <div className="flex justify-end border-b p-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={copied ? "Copied to clipboard" : label}
          onClick={async () => {
            try {
              await copyText(text);
              setCopied(true);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 2000);
              toast.success("Copied");
            } catch {
              toast.error("Copy unavailable. Select the text to copy it.");
            }
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : label}
        </Button>
      </div>
      <pre className="overflow-auto p-4 text-xs leading-6 whitespace-pre max-h-96">
        <code>{text}</code>
      </pre>
    </div>
  );
}
export function Secret({
  secret,
  onClose,
}: {
  secret: string;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Save your secret"
      description="Copy it now and store it securely. This value is only held in this open dialog; agent keys cannot be shown again."
      open={!!secret}
      onClose={onClose}
    >
      <Code text={secret} label="Copy secret" />
      <p className="text-xs text-muted-foreground">
        Keep it out of browser storage, source control and shared screenshots.
      </p>
      <Button onClick={onClose}>I've saved it</Button>
    </Modal>
  );
}
export function PageTabs({
  base,
  tabs,
  value,
}: {
  base: string;
  tabs: readonly (readonly [string, string])[];
  value: string;
}) {
  return (
    <nav
      aria-label={`${base} sections`}
      className="page-tabs flex max-w-full gap-1 overflow-x-auto border-b pb-2"
    >
      {tabs.map(([id, label]) => (
        <Button
          key={id}
          variant={value === id ? "secondary" : "ghost"}
          size="sm"
          asChild
        >
          <a
            aria-current={value === id ? "page" : undefined}
            href={`/app#${base}/${id}`}
          >
            {label}
          </a>
        </Button>
      ))}
    </nav>
  );
}
export const selectClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm shadow-xs disabled:opacity-50";
export function Events({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly string[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-3 text-sm font-medium">Events</legend>
      {options.map((event) => (
        <label key={event} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={value.includes(event)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, event]
                  : value.filter((v) => v !== event),
              )
            }
            className="size-4 accent-emerald-600"
          />
          {event === "*" ? "All events" : event}
        </label>
      ))}
    </fieldset>
  );
}
