import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, OnInit, ViewChild } from '@angular/core';

import { NimbleTableDirective, TableFieldValue, TableRecord } from '@ni/nimble-angular/table';

import {
  AtmlNode,
  ParsedAtml,
  countStats,
  formatSeconds,
  isAtml,
  outcomeClass,
  parseAtml,
} from '../../core/atml/atml';
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

interface StepRow extends TableRecord {
  id: string;
  parentId?: string;
  name: string;
  status: string;
  elapsed: string;
  measurement: string;
  value: string;
  unit: string;
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
  private fileById: Record<string, SystemLinkFile> = {};
  private workspaceNames: Record<string, string> = {};
  workspaces: WorkspaceInfo[] = [];
  filteredRows: FileRow[] = [];

  // ----- viewer (detail) state -----
  viewerLoading = false;
  viewerError = '';
  selectedFileName = '';
  parsed: ParsedAtml | null = null;
  stats = { passed: 0, failed: 0, other: 0, total: 0 };
  private stepRows: StepRow[] = [];
  private nodeById = new Map<string, AtmlNode>();

  // ----- step drawer state -----
  drawerOpen = false;
  selectedStep: AtmlNode | null = null;

  @ViewChild('fileTable', { read: NimbleTableDirective })
  private fileTable?: NimbleTableDirective<FileRow>;

  @ViewChild('stepTable', { read: NimbleTableDirective })
  private stepTable?: NimbleTableDirective<StepRow>;

  @ViewChild('stepDrawer')
  private stepDrawer?: ElementRef<HTMLElement & { show(): Promise<unknown>; close(reason?: unknown): void }>;

  constructor(
    private readonly fileService: FileService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

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
      this.fileById = Object.fromEntries(this.allFiles.map((f) => [f.id, f]));
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

  // ----- file selection → load + parse -----
  async onFileSelectionChange(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ selectedRecordIds: string[] }>).detail;
    const id = detail?.selectedRecordIds?.[0];
    if (!id) {
      return;
    }
    const file = this.fileById[id];
    this.selectedFileName = file ? fileName(file) : id;
    this.viewerLoading = true;
    this.viewerError = '';
    this.parsed = null;
    this.closeDrawer();
    try {
      const text = await this.fileService.downloadContent(id);
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) {
        throw new Error('File is not valid XML.');
      }
      if (!isAtml(doc)) {
        throw new Error('File is not recognized as ATML.');
      }
      const parsed = parseAtml(doc);
      if (!parsed) {
        throw new Error('ATML file recognized but no ResultSet was found.');
      }
      this.parsed = parsed;
      this.stats = countStats(parsed.root);
      this.flattenSteps(parsed.root);
      this.scheduleStepRender();
    } catch (err) {
      this.viewerError = err instanceof Error ? err.message : String(err);
    } finally {
      this.viewerLoading = false;
      this.cdr.detectChanges();
    }
  }

  private flattenSteps(root: AtmlNode): void {
    const rows: StepRow[] = [];
    this.nodeById.clear();
    let seq = 0;
    const walk = (node: AtmlNode, parentId?: string): void => {
      const id = `s${seq++}`;
      this.nodeById.set(id, node);
      const meas = node.measurements[0];
      const dataItem = !meas && node.data[0] ? node.data[0] : null;
      rows.push({
        id,
        parentId,
        name: node.name,
        status: node.outcome || '',
        elapsed: node.time != null ? formatSeconds(node.time) : '',
        measurement: meas ? meas.name : dataItem ? dataItem.key : '',
        value: meas ? this.valuePreview(meas.value, meas.array) : dataItem ? dataItem.value : '',
        unit: meas ? meas.unit : '',
      });
      for (const child of node.children) {
        walk(child, id);
      }
    };
    walk(root);
    this.stepRows = rows;
  }

  private valuePreview(value: string, array: AtmlNode['measurements'][number]['array']): string {
    if (array && array.points.length) {
      const shape = array.dims.length ? array.dims.join(' × ') : String(array.points.length);
      const preview = array.points.slice(0, 5).map((p) => p.value).join(', ');
      const more = array.points.length > 5 ? ', …' : '';
      return `[${preview}${more}] (${shape})`;
    }
    return value ?? '';
  }

  onStepSelectionChange(event: Event): void {
    const detail = (event as CustomEvent<{ selectedRecordIds: string[] }>).detail;
    const id = detail?.selectedRecordIds?.[0];
    const node = id ? this.nodeById.get(id) : undefined;
    if (node) {
      this.selectedStep = node;
      this.drawerOpen = true;
      this.cdr.detectChanges();
      window.requestAnimationFrame(() => void this.stepDrawer?.nativeElement.show());
    }
  }

  closeDrawer(): void {
    const wasOpen = this.drawerOpen;
    this.drawerOpen = false;
    this.selectedStep = null;
    if (wasOpen) {
      try {
        this.stepDrawer?.nativeElement.close();
      } catch {
        /* drawer may already be closing */
      }
    }
  }

  outcomeClass = outcomeClass;

  /** Public value preview for measurement/parameter items (handles arrays). */
  preview(item: { value: string; array: import('../../core/atml/atml').ArrayData | null }): string {
    return this.valuePreview(item.value, item.array);
  }

  elapsedRange(): string {
    if (!this.parsed) {
      return '';
    }
    const { start, end } = this.parsed.summary;
    if (!start || !end) {
      return '—';
    }
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return isNaN(ms) || ms < 0 ? '—' : formatSeconds(ms / 1000);
  }

  formatDate(iso?: string | null): string {
    if (!iso) {
      return '—';
    }
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : d.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
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
    if (this.fileTable) {
      await this.fileTable.setData(this.filteredRows);
    }
  }

  private async renderStepRows(): Promise<void> {
    if (this.stepTable) {
      await this.stepTable.setData(this.stepRows);
    }
  }

  private scheduleRender(): void {
    window.requestAnimationFrame(() => {
      void this.renderRows();
    });
  }

  private scheduleStepRender(): void {
    window.requestAnimationFrame(() => {
      void this.renderStepRows();
    });
  }
}