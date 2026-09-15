import { findChainBreak, type ChainBreak } from '../../../domain/admin/auditChain.js'
import type { AdminAuditEntry } from '../../../domain/entities/admin.js'
import type { AdminAuditFilter } from '../../../domain/repositories/admin.js'
import type { PageQuery } from '../../../domain/repositories/IRepository.js'
import type { Repositories } from '../../../domain/repositories/Repositories.js'

/**
 * Reading the audit log, and checking it against itself — 12-admin-console.md
 * §5, §9 T24.
 *
 * There is no write path here, deliberately. Rows are appended by `withAudit`
 * and by nothing else, so a service whose job is *reading* the log has no
 * reason to be able to add to it — and a future endpoint that wanted to would
 * have to go through the wrapper like everything else.
 */

export interface AuditVerification {
  readonly ok: boolean
  readonly checked: number
  /** The **first** break, or `null`. See `findChainBreak` for why only the first. */
  readonly brokenAt: ChainBreak | null
}

export class AuditService {
  constructor(private readonly repos: Repositories) {}

  async list(filter: AdminAuditFilter, page: PageQuery): Promise<AdminAuditEntry[]> {
    return this.repos.adminAudit.list(filter, page)
  }

  /**
   * ★★ Walks the whole chain, oldest first, and reports where it stops adding
   * up — `GET /audit/verify`.
   *
   * Paged rather than loaded whole: an audit log is append-only and therefore
   * grows for ever, and a verification that needs the entire table in memory
   * stops being runnable at exactly the point it starts mattering. Each page
   * carries the previous page's tip hash forward, so a break *at a page
   * boundary* is caught like any other — which is the bug a naive
   * page-at-a-time implementation has and never notices.
   *
   * What a break means, concretely: somebody with database access deleted or
   * edited a row. The chain cannot prevent that. It makes it impossible to do
   * quietly, which is the strongest guarantee a log the application writes can
   * honestly offer.
   */
  async verify(pageSize = 500): Promise<AuditVerification> {
    let afterId: string | undefined
    let prevHash: string | null = null
    let checked = 0

    for (;;) {
      const page: AdminAuditEntry[] = await this.repos.adminAudit.listForVerification(
        afterId,
        pageSize,
      )
      if (page.length === 0) break

      const broken = findChainBreak(page, prevHash, checked)
      if (broken !== null) return { ok: false, checked: checked + page.length, brokenAt: broken }

      checked += page.length
      prevHash = page.at(-1)!.hash
      afterId = page.at(-1)!.id
      if (page.length < pageSize) break
    }

    return { ok: true, checked, brokenAt: null }
  }
}
