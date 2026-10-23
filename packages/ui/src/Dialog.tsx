import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 480,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(92vw,var(--dialog-w))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel border border-line bg-surface p-5 shadow-lift outline-none"
          style={{ ["--dialog-w" as string]: `${width}px` }}
        >
          <RadixDialog.Title className="text-[16px] font-semibold text-text-1">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="mt-1 text-[13px] text-text-2">{description}</RadixDialog.Description>}
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
