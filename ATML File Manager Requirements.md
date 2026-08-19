# OOTB Dashboard / Web App Requirements Template

**Purpose:** Capture the business problem, intended use, scope, success criteria, ownership, and stakeholder alignment needed to approve an Out-of-the-Box (OOTB) SystemLink dashboard or web application before development, enhancement, or reuse begins.

**Document intent:** This is a reviewed requirements artifact. It is not intended to be a project tracker or continuously updated status document.

**Scope of this document:** This document captures the business and functional **WHY / WHAT** for an OOTB dashboard or web application. It focuses on the business problem, intended users, scope, information needs, success criteria, ownership, and stakeholder alignment. Technical implementation details belong in the HLD and developer guidance.

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
| Epic | https://dev.azure.com/ni/DevCentral/_workitems/edit/3977623 |
| Business Owner | Moyer |
| Technical Owner | Michael Castaneda |
| Reviewer(s) | Fred, Mark, Chris |
| Stakeholder(s) | Josh, Moyer, R&D Product Owner |

**Summary**

ATML File Manager is a SystemLink-embedded web app that lets test and quality engineers browse ATML (IEEE 1671/1636) and generic XML files already stored in the SystemLink File Service, render ATML test results in a human-readable summary + step tree without external tooling, and import ATML files to create native SystemLink Test Monitor results. It exists as an OOTB asset because ATML is a common standardized test-results interchange format that SystemLink does not natively visualize or ingest, forcing customers to build one-off parsers or inspect raw XML manually.

---

## 2. Business Problem

1. **What business problem is being addressed?**
   TestStand systems and third-party test executives frequently emit results in the standardized ATML (IEEE 1671 / 1636) XML format. SystemLink cannot natively display these files in a readable form or turn them into Test Monitor results, so the data captured in ATML files is effectively locked away from SystemLink's analysis, dashboards, and reporting.

2. **Who experiences this problem?**
   Test engineers, quality engineers, and production/manufacturing engineers who receive or archive ATML result files, plus SystemLink administrators responsible for getting existing test data into the platform.

3. **How is the work performed today?**
   Users open ATML XML files in a browser or text editor and read the raw markup, or write custom scripts/parsers to extract measurements, limits, and outcomes. Getting the data into SystemLink Test Monitor requires bespoke ingestion code or manual re-entry.

4. **What is inefficient, manual, inconsistent, unclear, or difficult today?**
   Reading raw ATML XML is error-prone and slow; nested test groups, measurements, limits, and pass/fail outcomes are hard to follow. Custom parsers are duplicated per customer/project, are inconsistent, and must be maintained. There is no standard, supported path from an ATML file to a SystemLink result. ATML data by itself cannot be plotted in SystemLink Dashboards and Data Spaces.

5. **What information, visibility, or workflow is missing?**
   A single place inside SystemLink to (a) find ATML/XML files across workspaces, (b) see an ATML result's overall outcome, UUT/serial number, station, operator, timing, and full step/measurement hierarchy, and (c) ingest that file into a native Test Monitor result that participates in SystemLink dashboards and Test Insights.

6. **Why is this worth addressing as an OOTB dashboard or web app?**
   ATML is an industry-standard format generated OOTB by TestStand. The need to ingest ATML data recurs across many customers. A reusable OOTB app removes duplicated custom-ingestion efforts, gives a consistent supported viewing/import experience, and demonstrates a repeatable pattern for onboarding standardized test data and historical TestStand data into SystemLink.

---

## 3. Intended Users and Use

1. **Who is the intended audience for this asset?**
   Test engineers, quality engineers, and production engineers working with ATML-format test results, as well as SystemLink administrators onboarding existing test data.

2. **What job, workflow, or decision does this asset support?**
   - Locating ATML/XML files stored in SystemLink (by workspace, file name, and creation date range).
   - Inspecting an ATML result's outcome and full step/measurement detail to triage failures or verify a run, without leaving SystemLink or using external tools.
   - Importing ATML files into SystemLink and optionally creating Test Monitor results so the data is available to dashboards, Test Insights, and standard SystemLink workflows.

3. **What specific information or capability does the application provide to the user to complete the workflow?**
   The ingestion of ATML data. The ability to view raw ATML data in a rendered Step tree consistent with the SystemLink Test Insights UI.

---

## 4. Scope

### In Scope
1. Which SystemLink editions and versions must be supported?
Valinor (SL Base, Full, Pro), SLE, and SLS (w/ Data Management)

2. Does this app require any configuration?
No

3. How will this application be configured? At runtime/build?
N/A

4. Provide a list of in-scope functionality:
- Browsing File Service files, scoped to XML/ATML extensions, with filtering by workspace, file-name search, and creation date range, plus sortable columns.
- Searching across all workspaces (Elasticsearch-backed search) and scoped querying within a selected workspace.
- Rendering ATML (IEEE 1671/1636) test results as a summary header (outcome, UUT/serial, part number, station, operator, timing) plus an expandable, searchable step/measurement tree with pass/fail statistics.
- Viewing generic (non-ATML) XML in a readable rendered view and a raw-XML view.
- A step-details slide-out showing per-step info, measurements (value/units/limits/comparator), inputs, and outputs; image attachments viewable in a lightbox.
- Downloading the original file.
- Importing ATML files: uploading to the File Service in a chosen workspace, optionally creating SystemLink Test Monitor results and steps from the parsed ATML, with de-duplication via an "ATML Checksum" property and an option to replace existing files/results that have been previously imported.
- Deep links from imported results into Test Insights result/step views.
- Up to 1k bulk transfers of typical sized ATML files (<1GB). 5x concurrent upload, 10k step chunks
- Auto-Refresh every 30 seconds

### Out of Scope

- Authoring, editing, deleting, or exporting ATML files.
- Support for non-ATML/XML file formats (e.g., binary, TDMS, PDF).
- automated/scheduled ingestion pipelines or server-side background import.
- Custom analytics, trending, or visualization aside from what native Test Insights provide once results are imported.
- Validation or normalization of ATML beyond what is needed to render and map results.
- Large scale bulk transfers 1k+ files
- Custom step types / non-standard ATML structures
- Multi-GB ATML files


## 5. Security and Permissions

All requests are made same-origin using the host SystemLink session cookie; the app performs no independent authentication and inherits the signed-in user's workspace permissions.

| Service | Read/Write |
|---|---|
| File Service (`/nifile/v1`) — search/query files, download content, upload files, update metadata, delete files | Read/Write |
| User Service (`/niuser/v1`) — list workspaces | Read |
| Test Monitor Service (`/nitestmonitor/v2`) — query/create/delete results and steps | Read/Write |


## 6. Success Criteria

_Define what business success means if this asset is delivered. These should describe outcomes, not implementation details._

- Users can find and open ATML/XML files stored in SystemLink without downloading them or using external tools.
- Users can read an ATML result's outcome, UUT/station/operator context, and full step/measurement detail directly in SystemLink instead of parsing raw XML.
- Users can triage a failed ATML run and identify the contributing step(s) faster than the current manual/raw-XML process.
- Users can import ATML files and create native SystemLink Test Monitor results so the data participates in dashboards and Test Insights.
- Duplicate imports are avoided so the same ATML file does not create redundant results.
- The asset provides a reusable OOTB example for onboarding a standardized test format (ATML) that can be adopted without custom parser development.
- The asset reduces reliance on ad hoc scripts, custom parsers, or direct file inspection to work with ATML data.

---

## 7. Alignment and Ownership

1. **Does an equivalent solution already exist?**
   No known OOTB SystemLink app renders ATML results or imports ATML into Test Monitor. SystemLink provides file storage, Test Monitor, and Test Insights, but no ATML-aware viewer/importer; ATML is currently ingested using custom parsers/routines.

2. **Is there an existing dashboard, web app, prototype, customer-specific asset, or R&D implementation that should be reused or enhanced?**
   This app reuses existing SystemLink services (File, User, Test Monitor). This app was taught to ingest ATML data using an existing SLS ATML ingestion routine. The ATML ingestion routine is not compatible with SLE OOTB due to dependencies on non-standard libraries. This solution mitigates the risk of not being able to leverage the ATML ingestion routine.

3. **Does this asset overlap with another roadmap item, customer deliverable, or internal initiative?**
   _TBD — Potential overlap with any planned native test-data import capability in Test Monitor/Test Insights. _Confirm with product owners. (TBD)_

4. **If an R&D solution planned, is it in progress, or when will it be available? Provide the AzDO ticket.**
   _TBD._ To be confirmed.

5. **Who owns the asset after release or publication?**
   Mark and Chris

6. **Who should review the asset before development proceeds?**
   _TBD — SystemLink apps/OOTB reviewer(s) and a Test Insights/Test Monitor stakeholder._

7. **Is this intended as a permanent solution for a product-gap?**
   No

8. **Will this app be sold?**
   No

9. **Are there known dependencies, risks, or open questions that could affect whether this should proceed?**
   - Depends on the File, User, and Test Monitor services and the host SystemLink session (same-origin embedding). Requires write access to these services.
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
