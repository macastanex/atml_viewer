import { Injectable } from '@angular/core';

import { SystemLinkContextService } from './systemlink-context.service';

/** A file as returned by the SystemLink File service. */
export interface SystemLinkFile {
  id: string;
  created?: string;
  updated?: string;
  size?: number;
  size64?: number;
  workspace?: string;
  properties?: Record<string, string>;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
}

const FILE_API = 'nifile/v1/service-groups/Default';

@Injectable({ providedIn: 'root' })
export class FileService {
  constructor(private readonly context: SystemLinkContextService) {}

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(
      this.context.buildApiUrl(path),
      this.context.buildRequestInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      throw new Error(this.describeError(res.status, res.statusText));
    }
    return (await res.json()) as T;
  }

  private describeError(status: number, statusText: string): string {
    if (status === 401 || status === 403) {
      return 'Not authorized. Open this app from within SystemLink so your session is used.';
    }
    return `Request failed (${status} ${statusText}).`;
  }

  /** Load all workspaces the user can see, keyed for name lookup. */
  async loadWorkspaces(): Promise<WorkspaceInfo[]> {
    try {
      const res = await fetch(
        this.context.buildApiUrl('niuser/v1/workspaces?take=1000'),
        this.context.buildRequestInit({ headers: { Accept: 'application/json' } }),
      );
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as { workspaces?: WorkspaceInfo[]; value?: WorkspaceInfo[] };
      return data.workspaces ?? data.value ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Search for ATML/XML files (all workspaces) via the Elasticsearch-backed
   * search-files endpoint, newest first.
   */
  async searchAtmlFiles(searchText: string): Promise<SystemLinkFile[]> {
    const clauses = ['(extension: "xml" OR extension: "atml")'];
    const text = (searchText ?? '').trim();
    if (text) {
      const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      clauses.push(`name: "*${safe}*"`);
    }
    const data = await this.postJson<{ availableFiles?: SystemLinkFile[]; files?: SystemLinkFile[] }>(
      `${FILE_API}/search-files`,
      { filter: clauses.join(' AND '), orderBy: 'created', orderByDescending: true, take: 1000 },
    );
    return data.availableFiles ?? data.files ?? [];
  }
}

/** File display helpers (framework-agnostic). */
export function fileName(f: SystemLinkFile): string {
  return f.properties?.['Name'] ?? f.properties?.['name'] ?? f.id;
}

export function fileExtension(f: SystemLinkFile): string {
  const name = fileName(f);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileSizeBytes(f: SystemLinkFile): number | undefined {
  return f.size ?? f.size64;
}
