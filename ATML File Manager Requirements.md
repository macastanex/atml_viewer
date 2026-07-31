# OOB Dashboard / Web App Requirements Template

**Purpose:** Capture the business problem, intended use, scope, success criteria, ownership, and stakeholder alignment needed to approve an Out-of-the-Box (OOB) SystemLink dashboard or web application before development, enhancement, or reuse begins.

**Document intent:** This is a reviewed requirements artifact. It is not intended to be a project tracker or continuously updated status document.

**Scope of this document:** This document captures the business and functional **WHY / WHAT** for an OOB dashboard or web application. It focuses on the business problem, intended users, scope, information needs, success criteria, ownership, and stakeholder alignment. Technical implementation details belong in the HLD and developer guidance.

**What belongs elsewhere:** Technical design, UI layout, filtering, drilldown, deployment, security implementation, data mappings, detailed testing approach, and coding standards belong in the HLD, developer guide, or review checklist.

[[_TOC_]]

---

## 1. Asset Summary

| Field | Value |
|---|---|
| Asset Name | ATML File Manager |
| Asset Type | Web App |
| Approach | Build New |
| Existing Asset or Example, if applicable | N/A
| Epic / Work Item | https://dev.azure.com/ni/DevCentral/_workitems/edit/3977623 |
| Business Owner | _TBD_ |
| Technical Owner | Michael Castaneda |
| Reviewer(s) | _TBD_ |

**Summary**

ATML File Manager is a SystemLink-embedded web app that lets test and quality engineers browse ATML (IEEE 1671/1636) and generic XML files already stored in the SystemLink File Service, render ATML test results in a human-readable summary + step tree without external tooling, and import ATML files to create native SystemLink Test Monitor results. It exists as an OOB asset because ATML is a common standardized test-results interchange format that SystemLink does not natively visualize or ingest, forcing customers to build one-off parsers or inspect raw XML manually.

---

## 2. Business Problem

1. **What business problem is being addressed?**
   Test systems and third-party test executives frequently emit results in the standardized ATML (IEEE 1671 / 1636) XML format. SystemLink cannot natively display these files in a readable form or turn them into Test Monitor results, so the data captured in ATML files is effectively locked away from SystemLink's analysis, dashboards, and reporting.

2. **Who experiences this problem?**
   Test engineers, quality engineers, and production/manufacturing engineers who receive or archive ATML result files, plus SystemLink administrators responsible for getting existing test data into the platform.

3. **How is the work performed today?**
   Users open ATML XML files in a browser or text editor and read the raw markup, or write custom scripts/parsers to extract measurements, limits, and outcomes. Getting the data into SystemLink Test Monitor requires bespoke ingestion code or manual re-entry.

4. **What is inefficient, manual, inconsistent, unclear, or difficult today?**
   Reading raw ATML XML is error-prone and slow; nested test groups, measurements, limits, and pass/fail outcomes are hard to follow. Custom parsers are duplicated per customer/project, are inconsistent, and must be maintained. There is no standard, supported path from an ATML file to a SystemLink result.

5. **What information, visibility, or workflow is missing?**
   A single place inside SystemLink to (a) find ATML/XML files across workspaces, (b) see an ATML result's overall outcome, UUT/serial number, station, operator, timing, and full step/measurement hierarchy, and (c) promote that file into a native Test Monitor result that participates in SystemLink dashboards and Test Insights.

6. **Why is this worth addressing as an OOB dashboard or web app?**
   ATML is an industry-standard interchange format, so the same need recurs across many customers. A reusable OOB app removes duplicated custom-parser effort, gives a consistent supported viewing/import experience, and demonstrates a repeatable pattern for onboarding standardized test data into SystemLink.

---

## 3. Intended Users and Use

1. **Who is the intended audience for this asset?**
   Test engineers, quality engineers, and production engineers working with ATML-format test results, as well as SystemLink administrators onboarding existing test data.

2. **What job, workflow, or decision does this asset support?**
   - Locating ATML/XML files stored in SystemLink (by workspace, file name, and creation date range).
   - Inspecting an ATML result's outcome and full step/measurement detail to triage failures or verify a run, without leaving SystemLink or using external tools.
   - Importing ATML files into SystemLink and optionally creating Test Monitor results so the data is available to dashboards, Test Insights, and standard SystemLink workflows.

3. **What information does the user need to complete that job, workflow, or decision?**
   File name, extension, size, workspace, and creation date for discovery; and for each ATML result: overall outcome, UUT serial number, part number, test station, operator, start/end time, total time, and the hierarchy of test groups, steps, measurements (value, units, limits, comparator), inputs, and outputs.

4. **Is this intended for a broad reusable OOB use case or a narrower example/reference implementation?**
   Both. It is intended as a broadly reusable OOB app for ATML viewing and import, while also serving as a reference implementation for parsing a standardized test format and mapping it onto the File and Test Monitor services.

---

## 4. Scope

### In Scope

- Browsing File Service files, scoped to XML/ATML extensions, with filtering by workspace, file-name search, and creation date range, plus sortable columns.
- Searching across all workspaces (Elasticsearch-backed search) and scoped querying within a selected workspace.
- Rendering ATML (IEEE 1671/1636) test results as a summary header (outcome, UUT/serial, part number, station, operator, timing) plus an expandable, searchable step/measurement tree with pass/fail statistics.
- Viewing generic (non-ATML) XML in a readable rendered view and a raw-XML view.
- A step-details slide-out showing per-step info, measurements (value/units/limits/comparator), inputs, and outputs; image attachments viewable in a lightbox.
- Downloading the original file.
- Importing ATML files: uploading to the File Service in a chosen workspace, optionally creating SystemLink Test Monitor results and steps from the parsed ATML, with de-duplication via an "ATML Checksum" property and an option to replace existing files/results.
- Deep links from imported results into Test Insights result/step views.
- Embedded operation inside SystemLink using the host session (same-origin) and following the active SystemLink theme via NI Nimble.

### Out of Scope

- Authoring, editing, or exporting ATML files.
- Support for non-ATML/XML file formats (e.g., binary, TDMS, PDF).
- Bulk/automated/scheduled ingestion pipelines or server-side background import.
- Custom analytics, trending, or yield dashboards beyond what native SystemLink/Test Insights provide once results are imported.
- User/permission administration or workspace management (relies on existing SystemLink permissions).
- Validation or normalization of ATML beyond what is needed to render and map results.

## 5. Security and Permissions

All requests are made same-origin using the host SystemLink session cookie; the app performs no independent authentication and inherits the signed-in user's workspace permissions.

| Service | Read/Write |
|---|---|
| File Service (`/nifile/v1`) — search/query files, download content, upload files, update metadata, delete files | Read/Write |
| User Service (`/niuser/v1`) — list workspaces | Read |
| Test Monitor Service (`/nitestmonitor/v2`) — query/create/delete results and steps | Read/Write |


## 6. Success Criteria

_Define what business success means if this asset is delivered. These should describe outcomes, not implementation details._

| Success Criteria |
|---|
| Users can find and open ATML/XML files stored in SystemLink without downloading them or using external tools. |
| Users can read an ATML result's outcome, UUT/station/operator context, and full step/measurement detail directly in SystemLink instead of parsing raw XML. |
| Users can triage a failed ATML run and identify the contributing step(s) faster than the current manual/raw-XML process. |
| Users can import ATML files and create native SystemLink Test Monitor results so the data participates in dashboards and Test Insights. |
| Duplicate imports are avoided so the same ATML file does not create redundant results. |
| The asset provides a reusable OOB example for onboarding a standardized test format (ATML) that can be adopted without custom parser development. |
| The asset reduces reliance on ad hoc scripts, custom parsers, or direct file inspection to work with ATML data. |

---

## 7. Alignment and Ownership

1. **Does an equivalent solution already exist?**
   No known OOB SystemLink app renders ATML results or imports ATML into Test Monitor. SystemLink provides file storage, Test Monitor, and Test Insights, but no ATML-aware viewer/importer; customers currently build custom parsers.

2. **Is there an existing dashboard, web app, prototype, customer-specific asset, or R&D implementation that should be reused or enhanced?**
   This app reuses existing SystemLink services (File, User, Test Monitor) and NI Nimble UI patterns, and links into Test Insights. _Confirm whether any customer-specific ATML importer exists that should be consolidated. (TBD)_

3. **Is an R&D solution planned, in progress, or already available?**
   _TBD — confirm with the SystemLink/Test Insights product team whether native ATML ingestion is on the roadmap._

4. **Does this asset overlap with another roadmap item, customer deliverable, or internal initiative?**
   Potential overlap with any planned native test-data import capability in Test Monitor/Test Insights. _Confirm with product owners. (TBD)_

5. **Has the proposed scope been reviewed with the appropriate stakeholders?**
   _TBD — pending review with business/technical owners and reviewers named in Section 1._

6. **Who owns the asset after release or publication?**
   _TBD — to be assigned (see Business/Technical Owner in Section 1)._

7. **Who should review the asset before development proceeds?**
   _TBD — SystemLink apps/OOB reviewer(s) and a Test Insights/Test Monitor stakeholder._

8. **Is this intended as a reusable OOB example, a strategic product-gap solution, or both?**
   Both: a reusable OOB app addressing the gap in ATML viewing/ingestion, and a reference implementation for mapping a standardized format onto SystemLink services.

9. **Are there known dependencies, risks, or open questions that could affect whether this should proceed?**
   - Depends on the File, User, and Test Monitor services and the host SystemLink session (same-origin embedding).
   - Depends on the browser's Web Crypto API (SHA-256) for checksum-based de-duplication.
   - ATML variability: the parser targets IEEE 1671/1636 result structures; non-conforming or vendor-extended files may not map cleanly.
   - Open question: whether native ATML support is planned in-product, which could affect long-term ownership/scope.

---

## Appendix A: Belongs Outside This Requirements Document

The following items should be captured in the HLD, developer guide, coding standards, review checklist, or release process instead of this requirements document:

- UI layout and page design
- Dashboard or web app navigation
- Filtering, sorting, drilldown, and export mechanics
- Visualization selection
- Technical architecture
- Data architecture and mappings
- API design or backend service changes
- Security implementation details
- Deployment and configuration
- CI/CD, repository, and package structure
- Unit, system, regression, and compatibility testing details
- Code review and static analysis requirements
- Operational runbooks and support procedures
