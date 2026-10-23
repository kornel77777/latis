import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Chip({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-2",
        className,
      )}
      {...rest}
    />
  );
}
