import { cn } from "@/lib/utils"
import { runtimeConfig } from "@/lib/runtime-config"

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-2xl font-medium tracking-wider", className)}>
      {runtimeConfig.organizationName || "COYOT3"}
    </span>
  )
}
