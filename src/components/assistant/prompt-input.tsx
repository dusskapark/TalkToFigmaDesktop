import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useLayoutEffect, useRef } from 'react'

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Ask anything about your design...',
  className,
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [value])

  return (
    <div className={cn('border-input bg-background rounded-2xl border p-2 shadow-xs', className)}>
      <Textarea
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        className="min-h-[44px] max-h-[220px] resize-none border-none bg-transparent text-sm leading-6 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}
