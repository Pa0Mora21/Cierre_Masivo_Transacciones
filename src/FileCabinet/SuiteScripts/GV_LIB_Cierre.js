/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * 
 * Grupo Vida - Librería compartida del cierre masivo de transacciones abiertas.
 * Reglas de elegibilidad y cierre por tipo (OT, OV, OC, OTR) + Bitácora.
 */
define(['N/search', 'N/record', 'N/runtime', 'N/log'], (search, record, runtime, log) => {

    const TOL = 0.00001;
    const REC_LOG = 'customrecord_gv_cierre_log';

    const F = {
        ejec: 'custrecord_gv_cl_ejecucion',
        tipo: 'custrecord_gv_cl_tipo',
        numero: 'custrecord_gv_cl_numero',
        transId: 'custrecord_gv_cl_trans_id',
        res: 'custrecord_gv_cl_resultado',
        motivo: 'custrecord_gv_cl_motivo',
        pend: 'custrecord_gv_cl_pendiente',
        user: 'custrecord_gv_cl_usuario',
        modal: 'custrecord_gv_cl_modalidad'
    };

    const TIPOS = {
        WO: { type: 'workorder', label: 'Orden de trabajo', status: ['WorkOrd:B', 'WorkOrd:D'] },
        SO: { type: 'salesorder', label: 'Orden de venta', status: ['SalesOrd:A', 'SalesOrd:B', 'SalesOrd:D', 'SalesOrd:E'] },
        PO: { type: 'purchaseorder', label: 'Orden de compra', status: ['PurchOrd:B', 'PurchOrd:E', 'PurchOrd:F'] },
        TO: { type: 'transferorder', label: 'Orden de traslado', status: ['TrnfrOrd:B', 'TrnfrOrd:D', 'TrnfrOrd:E', 'TrnfrOrd:F'] }
    };

    const baseFilters = (tipo) => [['mainline', 'is', 'T'], 'and', ['status', 'anyof', TIPOS[tipo].status]];

    const listarCandidatos = (f) => {
        const out = [];
        (f.tipos || Object.keys(TIPOS)).forEach(tipo => {
            if (out.length >= f.max) return;
            const filters = baseFilters(tipo);
            if (f.desde) filters.push('and', ['trandate', 'onorafter', f.desde]);
            if (f.hasta) filters.push('and', ['trandate', 'onorbefore', f.hasta]);
            if (f.ubicaciones && f.ubicaciones.length) filters.push('and', ['location', 'anyof', f.ubicaciones]);

            const s = search.create({
                type: TIPOS[tipo].type,
                filters: filters,
                columns: [
                    search.createColumn({ name: 'trandate', sort: search.Sort.ASC }),
                    'tranid',
                    'location',
                    'status'
                ]
            });

            s.run().each(r => {
                out.push({
                    id: r.id,
                    tipo: tipo,
                    numero: r.getValue('tranid'),
                    fecha: r.getValue('trandate'),
                    ubicacion: r.getText('location'),
                    estado: r.getText('status')
                });
                return out.length < f.max;
            });
        });
        return out;
    };

    const sigueAbierta = (tipo, id) => {
        let ok = false;
        search.create({
            type: TIPOS[tipo].type,
            filters: [...baseFilters(tipo), 'and', ['internalid', 'anyof', id]],
            columns: ['tranid']
        }).run().each(() => {
            ok = true;
            return false;
        });
        return ok;
    };

    const sumaCompletions = (woId) => {
        let built = 0;
        search.create({
            type: 'workordercompletion',
            filters: [['mainline', 'is', 'T'], 'and', ['createdfrom', 'anyof', woId]],
            columns: ['quantity']
        }).run().each(r => {
            built += Math.abs(Number(r.getValue('quantity')) || 0);
            return true;
        });
        return built;
    };

    const evaluar = (tipo, id) => {
        const t = TIPOS[tipo];
        const rec = record.load({ type: t.type, id: id });

        if (tipo === 'WO') {
            const ordenado = Number(rec.getValue('quantity')) || 0;
            const ejecutado = sumaCompletions(id);
            const pendiente = Math.max(ordenado - ejecutado, 0);
            return {
                ordenado: ordenado,
                ejecutado: ejecutado,
                pendiente: pendiente,
                elegible: pendiente > TOL,
                motivo: pendiente > TOL ? '' : 'Sin cantidad pendiente por producir'
            };
        }

        let ordenado = 0, ejecutado = 0, pendiente = 0, transito = 0;
        const n = rec.getLineCount({ sublistId: 'item' });

        for (let i = 0; i < n; i++) {
            const g = (fieldId) => rec.getSublistValue({ sublistId: 'item', fieldId: fieldId, line: i });
            const qty = Number(g('quantity')) || 0;
            const closed = g('isclosed') === true || g('isclosed') === 'T';
            ordenado += qty;

            if (tipo === 'PO') {
                const rcv = Number(g('quantityreceived')) || 0;
                ejecutado += rcv;
                if (!closed) pendiente += Math.max(qty - rcv, 0);
            } else if (tipo === 'SO') {
                const ful = Number(g('quantityfulfilled')) || 0;
                ejecutado += ful;
                if (!closed) pendiente += Math.max(qty - ful, 0);
            } else { // TO
                const ful = Number(g('quantityfulfilled')) || 0;
                const rcv = Number(g('quantityreceived')) || 0;
                ejecutado += ful;
                if (!closed) {
                    pendiente += Math.max(qty - ful, 0);
                    transito += Math.max(ful - rcv, 0);
                }
            }
        }

        if (tipo === 'TO' && transito > TOL) {
            return {
                ordenado: ordenado,
                ejecutado: ejecutado,
                pendiente: pendiente,
                elegible: false,
                motivo: 'Mercancia en transito (enviada y no recibida)'
            };
        }

        return {
            ordenado: ordenado,
            ejecutado: ejecutado,
            pendiente: pendiente,
            elegible: pendiente > TOL,
            motivo: pendiente > TOL ? '' : 'Sin cantidad pendiente'
        };
    };

    const cerrar = (tipo, id) => {
        if (!sigueAbierta(tipo, id)) {
            return { resultado: 'Omitida', motivo: 'Ya no esta abierta', pendiente: 0 };
        }

        const ev = evaluar(tipo, id);
        if (!ev.elegible) {
            return { resultado: 'Omitida', motivo: ev.motivo, pendiente: ev.pendiente };
        }

        if (tipo === 'WO') {
            const c = record.transform({ fromType: 'workorder', fromId: id, toType: 'workorderclose' });
            c.setValue({ fieldId: 'quantity', value: ev.pendiente });
            c.save({ ignoreMandatoryFields: true });
        } else {
            const rec = record.load({ type: TIPOS[tipo].type, id: id });
            const n = rec.getLineCount({ sublistId: 'item' });
            for (let i = 0; i < n; i++) {
                rec.setSublistValue({ sublistId: 'item', fieldId: 'isclosed', line: i, value: true });
            }
            rec.save({ ignoreMandatoryFields: true });
        }

        return { resultado: 'Cerrada', motivo: '', pendiente: ev.pendiente };
    };

    const crearLog = (d) => {
        const r = record.create({ type: REC_LOG });
        r.setValue({ fieldId: 'name', value: String(d.numero || d.id).slice(0, 80) });
        r.setValue({ fieldId: F.ejec, value: d.ejecucion });
        r.setValue({ fieldId: F.tipo, value: TIPOS[d.tipo].label });
        r.setValue({ fieldId: F.numero, value: d.numero || '' });
        r.setValue({ fieldId: F.transId, value: String(d.id) });
        r.setValue({ fieldId: F.res, value: d.resultado || 'Pendiente' });
        r.setValue({ fieldId: F.motivo, value: String(d.motivo || '').slice(0, 300) });
        r.setValue({ fieldId: F.pend, value: String(d.pendiente === undefined ? '' : d.pendiente) });
        r.setValue({ fieldId: F.user, value: d.usuario || String(runtime.getCurrentUser().name || '') });
        r.setValue({ fieldId: F.modal, value: d.modalidad || 'Manual' });
        return r.save();
    };

    const actualizarLog = (logId, d) => record.submitFields({
        type: REC_LOG,
        id: logId,
        values: {
            [F.res]: d.resultado,
            [F.motivo]: String(d.motivo || '').slice(0, 300),
            [F.pend]: String(d.pendiente === undefined ? '' : d.pendiente)
        }
    });

    const pendientesLog = () => {
        const out = [];
        search.create({
            type: REC_LOG,
            filters: [[F.res, 'is', 'Pendiente']],
            columns: ['name', F.transId, F.tipo, F.ejec]
        }).run().each(r => {
            const label = r.getValue(F.tipo);
            const tipo = Object.keys(TIPOS).find(k => TIPOS[k].label === label);
            if (tipo) {
                out.push({
                    logId: r.id,
                    id: r.getValue(F.transId),
                    tipo: tipo,
                    numero: r.getValue('name'),
                    ejecucion: r.getValue(F.ejec)
                });
            }
            return out.length < 4000;
        });
        return out;
    };

    const leerLog = (ejecucion, max) => {
        const out = [];
        const filters = ejecucion ? [[F.ejec, 'is', ejecucion]] : [];
        search.create({
            type: REC_LOG,
            filters: filters,
            columns: [
                search.createColumn({ name: 'internalid', sort: search.Sort.DESC }),
                F.ejec, F.tipo, F.numero, F.res, F.motivo, F.pend, F.user, F.modal
            ]
        }).run().each(r => {
            out.push({
                ejec: r.getValue(F.ejec),
                tipo: r.getValue(F.tipo),
                numero: r.getValue(F.numero),
                res: r.getValue(F.res),
                motivo: r.getValue(F.motivo),
                pend: r.getValue(F.pend),
                user: r.getValue(F.user),
                modal: r.getValue(F.modal)
            });
            return out.length < (max || 200);
        });
        return out;
    };

    return {
        TOL,
        TIPOS,
        listarCandidatos,
        sigueAbierta,
        evaluar,
        cerrar,
        crearLog,
        actualizarLog,
        pendientesLog,
        leerLog
    };
});
