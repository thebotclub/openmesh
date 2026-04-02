{{/*
Expand the name of the chart.
*/}}
{{- define "openmesh.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openmesh.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "openmesh.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "openmesh.labels" -}}
helm.sh/chart: {{ include "openmesh.chart" . }}
{{ include "openmesh.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "openmesh.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openmesh.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "openmesh.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openmesh.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
LiteLLM URL — use user-provided llm.baseUrl or default to the sidecar service.
*/}}
{{- define "openmesh.litellmUrl" -}}
{{- if .Values.llm.baseUrl }}
{{- .Values.llm.baseUrl }}
{{- else if .Values.litellm.enabled }}
{{- printf "http://localhost:%d/v1" (int .Values.litellm.port) }}
{{- else }}
{{- print "https://api.openai.com/v1" }}
{{- end }}
{{- end }}

{{/*
OTel endpoint — defaults to sidecar when enabled.
*/}}
{{- define "openmesh.otelEndpoint" -}}
{{- if .Values.otelCollector.enabled }}
{{- printf "http://localhost:%d" (int .Values.otelCollector.port) }}
{{- else }}
{{- print "" }}
{{- end }}
{{- end }}
