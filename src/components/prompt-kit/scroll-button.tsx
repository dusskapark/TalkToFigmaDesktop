import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import type { VariantProps } from 'class-variance-authority'
import { useStickToBottomContext } from 'use-stick-to-bottom'

import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ScrollButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: VariantProps<typeof buttonVariants>['size']
}

export function ScrollButton({ className, variant = 'outline', size = 'icon-sm', ...props }: ScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(
        'rounded-full shadow-sm transition-all duration-150 ease-out',
        !isAtBottom ? 'translate-y-0 scale-100 opacity-100' : 'pointer-events-none translate-y-4 scale-95 opacity-0',
        className,
      )}
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest messages"
      {...props}
    >
      <ChevronDown className="size-4" />
    </Button>
  )
}
