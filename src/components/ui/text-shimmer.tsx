import * as React from 'react'
import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from "@/lib/utils"

export type TextShimmerProps = {
  as?: string
  duration?: number
  spread?: number
  children: ReactNode
} & HTMLAttributes<HTMLElement>

export function TextShimmer({
  as = "span",
  className,
  duration = 4,
  spread = 20,
  children,
  style,
  ...props
}: TextShimmerProps) {
  const dynamicSpread = Math.min(Math.max(spread, 5), 45)
  const Component = as as React.ElementType
  const shimmerRef = React.useRef<HTMLElement | null>(null)
  const [isReducedMotion, setIsReducedMotion] = React.useState(false)

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setIsReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  React.useEffect(() => {
    const node = shimmerRef.current
    if (!node || isReducedMotion || typeof node.animate !== 'function') return

    const animation = node.animate(
      [{ backgroundPosition: '200% 50%' }, { backgroundPosition: '-200% 50%' }],
      {
        duration: duration * 1000,
        iterations: Number.POSITIVE_INFINITY,
        easing: 'linear',
      },
    )

    return () => animation.cancel()
  }, [duration, isReducedMotion])

  return (
    <Component
      ref={shimmerRef as React.Ref<HTMLElement>}
      className={cn(
        isReducedMotion ? "text-muted-foreground font-medium" : "bg-size-[200%_auto] bg-clip-text font-medium text-transparent",
        className
      )}
      style={{
        ...(!isReducedMotion
          ? {
              backgroundImage: `linear-gradient(to right, var(--muted-foreground) ${50 - dynamicSpread}%, var(--foreground) 50%, var(--muted-foreground) ${50 + dynamicSpread}%)`,
              backgroundPosition: '200% 50%',
            }
          : {}),
        ...style,
      }}
      {...props}
    >
      {children}
    </Component>
  )
}
