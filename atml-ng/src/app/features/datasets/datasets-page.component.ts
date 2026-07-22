import { AfterViewInit, Component, OnInit, ViewChild } from '@angular/core';

import { NimbleTableDirective, TableFieldValue, TableRecord } from '@ni/nimble-angular/table';

import {
  FileService,
  SystemLinkFile,
  WorkspaceInfo,
  fileExtension,
  fileName,
  fileSizeBytes,
} from '../../core/systemlink/file.service';

interface FileRow extends TableRecord {
  id: string;
  name: string;
  extension: string;
  created: string;
  size: string;
  workspace: string;
  [key: string]: TableFieldValue;
}

interface TimePreset {
  value: string;
  label: string;
  ms: number | null;
}

const TIME_PRESETS: readonly TimePreset[] = [
  { value: 'all', label: 'Any time', ms: null },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 36e5 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 864e5 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 864e5 },
  { value: '90d', label: 'Last 90 days', ms: 90 * 864e5 },
  { value: '365d', label: 'Last year', ms: 365 * 864e5 },
];

@Component({
  selector: 'sl-datasets-page',
  standalone: false,
  templateUrl: './datasets-page.component.html',
  styleUrl: './datasets-page.component.scss',
})
export class DatasetsPageComponent implements AfterViewInit, OnInit {
  readonly timePresets = TIME_PRESETS;

  searchTerm = '';
  workspaceFilter = '';
  timeFilter = '30d';

  loading = false;
  errorMessage = '';
  filteredCount = 0;

  private allFiles: SystemLinkFile[] = [];
  private workspaceNames: Record<string, string> = {};
  workspaces: WorkspaceInfo[] = [];
  filteredRows: FileRow[] = [];

  @ViewChild('fileTable', { read: NimbleTableDirective })
  private fileTable?: NimbleTableDirective<FileRow>;

  constructor(private readonly fileService: FileService) {}

  ngOnInit(): void {
    void this.refresh();
  }

  ngAfterViewInit(): void {
    this.scheduleRender();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      if (this.workspaces.length === 0) {
        this.workspaces = await this.fileService.loadWorkspaces();
        this.workspaceNames = Object.fromEntries(this.workspaces.map((w) => [w.id, w.name]));
      }
      this.allFiles = await this.fileService.searchAtmlFiles(this.searchTerm);
      this.applyFilters();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.allFiles = [];
      this.applyFilters();
    } finally {
      this.loading = false;
    }
  }

  applyFilters(): void {
    const preset = TIME_PRESETS.find((p) => p.value === this.timeFilter) ?? TIME_PRESETS[0];
    const cutoff = preset.ms == null ? null : Date.now() - preset.ms;
    const rows: FileRow[] = [];
    for (const f of this.allFiles) {
      if (this.workspaceFilter && f.workspace !== this.workspaceFilter) {
        continue;
      }
      const created = new Date(f.created ?? f.updated ?? '').getTime();
      if (cutoff != null && (isNaN(created) || created < cutoff)) {
        continue;
      }
      rows.push(this.toRow(f));
    }
    this.filteredRows = rows;
    this.filteredCount = rows.length;
    this.scheduleRender();
  }

  private toRow(f: SystemLinkFile): FileRow {
    return {
      id: f.id,
      name: fileName(f),
      extension: fileExtension(f) || '—',
      created: this.formatDate(f.created ?? f.updated),
      size: this.formatSize(fileSizeBytes(f)),
      workspace: this.workspaceNames[f.workspace ?? ''] ?? '—',
    };
  }

  private formatDate(iso?: string): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? ''
      : d.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  }

  private formatSize(bytes?: number): string {
    if (bytes == null) {
      return '—';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private async renderRows(): Promise<void> {
    if (!this.fileTable) {
      return;
    }
    await this.fileTable.setData(this.filteredRows);
  }

  private scheduleRender(): void {
    window.requestAnimationFrame(() => {
      void this.renderRows();
    });
  }
}