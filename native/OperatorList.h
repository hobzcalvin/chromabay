#pragma once

/*
 * OPERATOR LIST
 * =============
 * 
 * This file includes all available operator implementations.
 * Each operator should include BaseOperator.h individually.
 * 
 * To add a new operator:
 * 1. Create YourOperator.h that extends BaseOperator
 * 2. Add REGISTER_OPERATOR(YourOperator) at the end of your .h file
 * 3. Add #include "YourOperator.h" below
 * 4. Recompile - your operator will be automatically available!
 */

// ========================================
// INCLUDE ALL OPERATORS HERE
// ========================================

// Include all operator headers here
// Add new operators by adding their #include statement

#include "RainbowOperator.h"
#include "BlendOperator.h"
#include "StrobeOperator.h"
#include "GradientOperator.h"
#include "MovingBlobOperator.h"
#include "FadeOperator.h"
#include "PerlinNoiseOperator.h"
#include "RaindropsOperator.h"
#include "TestOperator.h"
#include "RadialRainbowOperator.h"
#include "LumaToHueOperator.h"
#include "HueToLumaOperator.h"
#include "HueRotateOperator.h"
#include "PosterizeOperator.h"
#include "MirrorOperator.h"
#include "InvertOperator.h"
#include "PlasmaOperator.h"
#include "WaveOperator.h"
#include "StaticOperator.h"
#include "FireOperator.h"
#include "ScrollOperator.h"
#include "TileOperator.h"
#include "GlitchOperator.h"
#include "SymbolOperator.h"
#include "TextOperator.h"
#include "SvgFillOperator.h"
#include "BlurOperator.h"
#include "ConvolveOperator.h"

// Add your new operators here:
// #include "RainbowOperator.h"
// #include "SolidColorOperator.h"
// #include "YourCustomOperator.h" 