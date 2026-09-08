import Link from 'next/link';

/**
 * The name, the way the website writes it: the mark, then "quintal" with a
 * green full stop. The mark is the brand PNG used as a mask, so it takes the
 * current theme's green rather than shipping two images.
 */
export function Wordmark({
  href = '/',
  size = 'md',
  className,
}: {
  href?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const text = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';
  const mark = size === 'lg' ? 'h-9 w-8' : size === 'sm' ? 'h-5 w-[18px]' : 'h-7 w-6';
  return (
    <Link
      href={href}
      aria-label="Quintal"
      className={`text-foreground inline-flex items-center gap-2 leading-none font-[650] tracking-[-0.05em] ${text} ${className ?? ''}`}
    >
      <span aria-hidden="true" className={`brand-mark ${mark}`} />
      quintal
      <span aria-hidden="true" className="text-primary -ml-1.5">
        .
      </span>
    </Link>
  );
}
