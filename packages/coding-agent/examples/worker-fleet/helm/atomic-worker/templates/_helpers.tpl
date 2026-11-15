{{/* ATOMIC_DB: the database URL, from databaseSecret's `url` key when it is set, otherwise from `database`. */}}
{{- define "atomic-worker.databaseEnv" -}}
- name: ATOMIC_DB
{{- if .Values.databaseSecret }}
  valueFrom:
    secretKeyRef:
      name: "{{ .Values.databaseSecret }}"
      key: url
{{- else }}
  value: "{{ .Values.database }}"
{{- end }}
{{- end }}
