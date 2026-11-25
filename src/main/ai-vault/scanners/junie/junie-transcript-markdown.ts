import type { AiVaultSessionPreviewMessage } from '../../../../shared/ai-vault/contracts/ai-vault-types'

export type JunieTranscriptMessage = {
  role: AiVaultSessionPreviewMessage['role']
  text: string
}

// Bounds memory for one section when a tool dumps a huge output.
const MAX_SECTION_CHARS = 200_000

const SECTION_ROLES: Record<string, AiVaultSessionPreviewMessage['role'] | 'skip'> = {
  User: 'user',
  'User response': 'user',
  Junie: 'assistant',
  'Task result': 'assistant',
  Thinking: 'skip'
}

type OpenSection = {
  role: AiVaultSessionPreviewMessage['role']
  title: string | null
  lines: string[]
  chars: number
}

/** Splits a Junie transcript.md into messages; headings inside fenced blocks are body text. */
export class JunieTranscriptSplitter {
  private section: OpenSection | null = null
  private fence: string | null = null

  push(line: string): JunieTranscriptMessage | null {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (this.fence === null) {
        this.fence = fence
      } else if (fence.startsWith(this.fence)) {
        this.fence = null
      }
    }
    if (this.fence === null && !fence) {
      const heading = /^(#{2,3}) (.+?)\s*$/.exec(line)
      if (heading) {
        const flushed = this.flush()
        this.open(heading[1].length === 3, heading[2])
        return flushed
      }
    }
    this.append(line)
    return null
  }

  end(): JunieTranscriptMessage | null {
    return this.flush()
  }

  private open(isTool: boolean, title: string): void {
    if (isTool) {
      this.section = { role: 'tool', title, lines: [], chars: 0 }
      return
    }
    const role = SECTION_ROLES[title]
    this.section = role && role !== 'skip' ? { role, title: null, lines: [], chars: 0 } : null
  }

  private append(line: string): void {
    const section = this.section
    if (!section || section.chars > MAX_SECTION_CHARS) {
      return
    }
    section.lines.push(line)
    section.chars += line.length + 1
  }

  private flush(): JunieTranscriptMessage | null {
    const section = this.section
    this.section = null
    if (!section) {
      return null
    }
    const body = section.lines.join('\n').trim()
    const text = section.title ? `${section.title}\n${body}`.trim() : body
    return text ? { role: section.role, text } : null
  }
}
