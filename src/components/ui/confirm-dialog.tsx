import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

/** Branded centered confirm — never use window.confirm / browser prompts. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden p-0 sm:rounded-2xl">
        <div className="border-b border-slate-100 bg-primary px-5 py-4 text-white">
          <p className="text-xs font-bold uppercase tracking-wide text-white/70">D4EXAM</p>
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-base font-extrabold text-white">{title}</DialogTitle>
            {description ? (
              <DialogDescription className="text-sm text-white/85">{description}</DialogDescription>
            ) : null}
          </DialogHeader>
        </div>
        <DialogFooter className="flex flex-row gap-2 border-t border-slate-100 bg-white p-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="flex-1 font-semibold sm:flex-none"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            className={
              destructive
                ? "flex-1 bg-red-600 font-semibold hover:bg-red-700 sm:flex-none"
                : "flex-1 font-semibold sm:flex-none"
            }
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
