/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * 
 * Grupo Vida - Dashboard de cierre masivo de transacciones abiertas.
 * Flujo: Consultar (lista candidatos con elegibilidad) -> Cerrar seleccionados (envía al Map/Reduce) -> Resultados (bitácora).
 */
define(['./GV_LIB_Cierre', 'N/ui/serverWidget', 'N/search', 'N/task', 'N/runtime', 'N/redirect', 'N/url', 'N/log'],
(lib, ui, search, task, runtime, redirect, url, log) => {

    const MR_SCRIPT = 'customscript_gv_mr_cierre_masivo';
    const MR_DEPLOY = 'customdeploy_gv_mr_cierre_manual';
    const MAX_DEFAULT = 40;
    const MAX_TOPE = 60; // Cada documento evaluado consume gobernanza (límite del Suitelet)

    const ejecId = () => 'EJE-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

    const ubicaciones = () => {
        const out = [];
        search.create({
            type: 'location',
            filters: [['isinactive', 'is', 'F']],
            columns: ['name']
        }).run().each(r => {
            out.push({ id: r.id, name: r.getValue('name') });
            return out.length < 500;
        });
        return out;
    };

    const campos = (form, p) => {
        form.addFieldGroup({ id: 'g_filtros', label: 'Filtros' });

        const accion = form.addField({ id: 'custpage_accion', type: ui.FieldType.SELECT, label: 'Acción', container: 'g_filtros' });
        accion.addSelectOption({ value: 'consultar', text: 'Consultar candidatos' });
        accion.addSelectOption({ value: 'cerrar', text: 'Cerrar los seleccionados' });
        accion.defaultValue = 'consultar';

        const tipos = form.addField({ id: 'custpage_tipos', type: ui.FieldType.MULTISELECT, label: 'Tipos de transacción', container: 'g_filtros' });
        Object.keys(lib.TIPOS).forEach(k => tipos.addSelectOption({ value: k, text: lib.TIPOS[k].label }));
        if (p.custpage_tipos) tipos.defaultValue = p.custpage_tipos.split('\u0005');

        const d = form.addField({ id: 'custpage_desde', type: ui.FieldType.DATE, label: 'Fecha desde', container: 'g_filtros' });
        const h = form.addField({ id: 'custpage_hasta', type: ui.FieldType.DATE, label: 'Fecha hasta', container: 'g_filtros' });
        if (p.custpage_desde) d.defaultValue = p.custpage_desde;
        if (p.custpage_hasta) h.defaultValue = p.custpage_hasta;

        const u = form.addField({ id: 'custpage_ubic', type: ui.FieldType.MULTISELECT, label: 'Ubicación / Planta', container: 'g_filtros' });
        ubicaciones().forEach(x => u.addSelectOption({ value: x.id, text: x.name }));
        if (p.custpage_ubic) u.defaultValue = p.custpage_ubic.split('\u0005');

        const t = form.addField({ id: 'custpage_tol', type: ui.FieldType.FLOAT, label: 'Tolerancia: % máximo no ejecutado (100 = sin límite)', container: 'g_filtros' });
        t.defaultValue = p.custpage_tol || '100';

        const m = form.addField({ id: 'custpage_max', type: ui.FieldType.INTEGER, label: 'Máximo de documentos a evaluar (tope ' + MAX_TOPE + ')', container: 'g_filtros' });
        m.defaultValue = p.custpage_max || String(MAX_DEFAULT);
    };

    const filtrosDe = (p) => ({
        tipos: p.custpage_tipos ? p.custpage_tipos.split('\u0005') : Object.keys(lib.TIPOS),
        desde: p.custpage_desde || '',
        hasta: p.custpage_hasta || '',
        ubicaciones: p.custpage_ubic ? p.custpage_ubic.split('\u0005') : [],
        tol: p.custpage_tol === undefined || p.custpage_tol === '' ? 100 : Number(p.custpage_tol),
        max: Math.min(Number(p.custpage_max) || MAX_DEFAULT, MAX_TOPE)
    });

    const tablaCandidatos = (form, f) => {
        const sl = form.addSublist({ id: 'custpage_cand', type: ui.SublistType.LIST, label: 'Candidatos' });
        sl.addField({ id: 'sel', type: ui.FieldType.CHECKBOX, label: 'Cerrar' });
        sl.addField({ id: 'tipo', type: ui.FieldType.TEXT, label: 'Tipo' });
        sl.addField({ id: 'numero', type: ui.FieldType.TEXT, label: 'Número' });
        sl.addField({ id: 'fecha', type: ui.FieldType.TEXT, label: 'Fecha' });
        sl.addField({ id: 'ubic', type: ui.FieldType.TEXT, label: 'Ubicación' });
        sl.addField({ id: 'ord', type: ui.FieldType.TEXT, label: 'Ordenado' });
        sl.addField({ id: 'pend', type: ui.FieldType.TEXT, label: 'No ejecutado' });
        sl.addField({ id: 'pct', type: ui.FieldType.TEXT, label: '% no ejecutado' });
        sl.addField({ id: 'elig', type: ui.FieldType.TEXT, label: 'Resultado de la evaluación' });
        sl.addField({ id: 'motivo', type: ui.FieldType.TEXT, label: 'Motivo' });
        sl.addField({ id: 'rid', type: ui.FieldType.TEXT, label: 'ID' }).updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        sl.addField({ id: 'rtipo', type: ui.FieldType.TEXT, label: 'TipoKey' }).updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });

        const cand = lib.listarCandidatos(f);
        let i = 0;

        cand.forEach(c => {
            let ev;
            try {
                ev = lib.evaluar(c.tipo, c.id);
            } catch (e) {
                ev = { ordenado: 0, pendiente: 0, elegible: false, motivo: 'Error al evaluar: ' + e.message };
            }

            const pct = ev.ordenado ? (ev.pendiente / ev.ordenado) * 100 : 0;
            let ok = ev.elegible;
            let motivo = ev.motivo;

            if (ok && pct > f.tol) {
                ok = false;
                motivo = 'Supera la tolerancia (' + pct.toFixed(1) + '% > ' + f.tol + '%)';
            }

            const set = (id, v) => sl.setSublistValue({ id: id, line: i, value: String(v === undefined || v === '' ? ' ' : v) });

            set('sel', ok ? 'T' : 'F');
            set('tipo', lib.TIPOS[c.tipo].label);
            set('numero', c.numero);
            set('fecha', c.fecha);
            set('ubic', c.ubicacion);
            set('ord', ev.ordenado);
            set('pend', ev.pendiente);
            set('pct', pct.toFixed(1));
            set('elig', ok ? 'Elegible' : 'No elegible');
            set('motivo', motivo);
            set('rid', c.id);
            set('rtipo', c.tipo);
            i++;
        });

        return cand.length;
    };

    const resultados = (form, ejec) => {
        const sl = form.addSublist({ id: 'custpage_log', type: ui.SublistType.LIST, label: 'Bitácora' + (ejec ? ' - ' + ejec : ' (últimos 200)') });
        ['ejec:Ejecución', 'modal:Modalidad', 'tipo:Tipo', 'numero:Número', 'res:Resultado', 'motivo:Motivo', 'pend:No ejecutado', 'user:Usuario'].forEach(x => {
            const [id, label] = x.split(':');
            sl.addField({ id: id, type: ui.FieldType.TEXT, label: label });
        });

        lib.leerLog(ejec, 200).forEach((r, i) => {
            Object.keys(r).forEach(k => {
                sl.setSublistValue({ id: k, line: i, value: String(r[k] === '' ? ' ' : r[k]) });
            });
        });
    };

    const onRequest = (ctx) => {
        const p = ctx.request.parameters;
        const form = ui.createForm({ title: 'GV - Cierre masivo de transacciones abiertas' });

        try {
            if (ctx.request.method === 'GET' && p.vista === 'resultados') {
                resultados(form, p.ejec || '');
                return ctx.response.writePage(form);
            }

            campos(form, p);

            if (ctx.request.method === 'POST') {
                const f = filtrosDe(p);

                if (p.custpage_accion === 'cerrar') {
                    const n = ctx.request.getLineCount({ group: 'custpage_cand' });
                    const ejec = ejecId();
                    let enviados = 0;

                    for (let i = 0; i < n; i++) {
                        const g = (x) => ctx.request.getSublistValue({ group: 'custpage_cand', name: x, line: i });
                        if (g('sel') !== 'T') continue;

                        lib.crearLog({
                            ejecucion: ejec,
                            tipo: g('rtipo'),
                            id: g('rid'),
                            numero: g('numero'),
                            resultado: 'Pendiente',
                            modalidad: 'Manual',
                            pendiente: g('pend')
                        });
                        enviados++;
                    }

                    if (enviados) {
                        task.create({
                            taskType: task.TaskType.MAP_REDUCE,
                            scriptId: MR_SCRIPT,
                            deploymentId: MR_DEPLOY
                        }).submit();
                    }

                    const resUrl = url.resolveScript({
                        scriptId: runtime.getCurrentScript().id,
                        deploymentId: runtime.getCurrentScript().deploymentId,
                        params: { vista: 'resultados', ejec: ejec }
                    });

                    form.addField({ id: 'custpage_msg', type: ui.FieldType.INLINEHTML, label: ' ' }).defaultValue =
                        '<div style="padding:10px;font-size:14px"><b>' + enviados + ' documento(s) enviados a cierre.</b> Ejecución ' + ejec +
                        '. Revise el avance en <a href="' + resUrl + '">Resultados</a>.</div>';

                } else {
                    const n = tablaCandidatos(form, f);
                    form.addField({ id: 'custpage_msg', type: ui.FieldType.INLINEHTML, label: ' ' }).defaultValue =
                        '<div style="padding:6px;font-size:13px">' + n + ' documento(s) evaluados. Revise la selección y cambie la Acción a "Cerrar los seleccionados".</div>';
                }
            }

            form.addSubmitButton({ label: 'Ejecutar' });
            ctx.response.writePage(form);

        } catch (e) {
            log.error('GV SL cierre masivo', e.name + ': ' + e.message);
            ctx.response.write('Error: ' + e.message);
        }
    };

    return { onRequest };
});
