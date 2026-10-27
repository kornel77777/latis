import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "./cn";

export function Menu({
  trigger,
  children,
  align = "end",
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu.Root {...(onOpenChange && { onOpenChange })}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-44 rounded-control border border-line bg-surface p-1 shadow-lift"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      {...(onSelect && { onSelect })}
      {...(disabled && { disabled })}
      className={cn(
        // At least one line high; items with a second line (hints, install commands) grow instead of overlapping.
        "flex min-h-7 cursor-default select-none items-center gap-2 rounded-control px-2 py-1 text-[13px] leading-snug outline-none",
        "data-[highlighted]:bg-surface-2 data-[disabled]:opacity-45",
        danger ? "text-state-error" : "text-text-1",
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">
      {children}
    </DropdownMenu.Label>
  );
}
