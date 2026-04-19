import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

interface MarkdownProps {
  children: string
  className?: string
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        'max-w-none break-words text-sm leading-6',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-1',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-primary/80',
        '[&_pre]:bg-muted [&_pre]:border [&_pre]:border-border [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-3',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children: codeChildren, className: codeClass, ...rest } = props
            const isInline = !String(codeClass || '').includes('language-')
            if (isInline) {
              return (
                <code className="bg-muted rounded px-1.5 py-0.5 text-[0.85em]" {...rest}>
                  {codeChildren}
                </code>
              )
            }
            return (
              <code className={cn('block overflow-x-auto rounded-md p-3 text-xs', codeClass)} {...rest}>
                {codeChildren}
              </code>
            )
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
