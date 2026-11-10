import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/geo/controllers/geo.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";

const countryQuery = z.object({ countryId: fields.positiveInt.optional() });
const stateQuery = z.object({ stateId: fields.positiveInt.optional() });

export const geoRouter = Router();

geoRouter.use(requireAuth());

geoRouter.get("/countries", asyncHandler(ctrl.countries));
geoRouter.get("/states", validate({ query: countryQuery }), asyncHandler(ctrl.states));
geoRouter.get("/cities", validate({ query: stateQuery }), asyncHandler(ctrl.cities));
