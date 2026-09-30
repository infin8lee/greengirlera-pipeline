import { handleApi } from '../../server/api.js';

export const onRequest = context => handleApi(context.request, context.env);
